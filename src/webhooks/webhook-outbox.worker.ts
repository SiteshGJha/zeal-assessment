import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { StructuredLoggerService } from '../common/logger.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { signWebhookPayload } from './webhooks.service.js';

const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 10;
const DELIVERY_TIMEOUT_MS = 3000;
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_SECONDS = [1, 4, 16, 64];

/**
 * Sequential polling worker claiming pending webhook_outbox rows in short DB transactions
 * and dispatching HMAC-signed HTTP notifications outside transaction boundaries.
 */
@Injectable()
export class WebhookOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: StructuredLoggerService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_OUTBOX_WORKER === 'true') {
      return;
    }
    this.stopped = false;
    this.scheduleNext(POLL_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.runOnce()
        .then(() => undefined)
        .catch((err) => {
          this.logger.error('outbox_worker_poll_error', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.inFlight = null;
          this.scheduleNext(POLL_INTERVAL_MS);
        });
    }, delayMs);
    this.timer.unref();
  }

  /**
   * Claims up to BATCH_SIZE ready outbox rows and dispatches them sequentially.
   */
  async runOnce(): Promise<number> {
    const now = new Date();
    const claimed = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.webhookOutbox.findMany({
        where: {
          status: 'pending',
          nextAttemptAt: { lte: now },
        },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
        include: { subscription: true },
      });

      if (pending.length === 0) {
        return [];
      }

      await tx.webhookOutbox.updateMany({
        where: { id: { in: pending.map((p) => p.id) }, status: 'pending' },
        data: { status: 'processing' },
      });

      return pending;
    });

    for (const row of claimed) {
      await this.deliverRow(row);
    }

    return claimed.length;
  }

  private async deliverRow(row: {
    id: string;
    eventType: string;
    payload: unknown;
    attempts: number;
    subscription: { targetUrl: string; secret: string };
  }): Promise<void> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify(row.payload);
    const signature = signWebhookPayload(row.subscription.secret, timestamp, rawBody);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    try {
      const res = await fetch(row.subscription.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Event': row.eventType,
          'X-Webhook-Id': row.id,
          'X-Signature-Timestamp': timestamp,
          'X-Signature-SHA256': signature,
        },
        body: rawBody,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        await this.prisma.webhookOutbox.update({
          where: { id: row.id },
          data: {
            status: 'delivered',
            attempts: row.attempts + 1,
            deliveredAt: new Date(),
            lastError: null,
          },
        });
        return;
      }

      await this.recordFailure(row.id, row.attempts, `HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(timer);
      await this.recordFailure(
        row.id,
        row.attempts,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async recordFailure(id: string, previousAttempts: number, errorMsg: string): Promise<void> {
    const attempts = previousAttempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.prisma.webhookOutbox.update({
        where: { id: id },
        data: {
          status: 'failed',
          attempts,
          lastError: errorMsg,
        },
      });
      this.logger.error('webhook_delivery_failed_permanently', { webhookId: id, attempts, errorMsg });
      return;
    }

    const delaySec = RETRY_BACKOFF_SECONDS[attempts - 1] ?? 64;
    await this.prisma.webhookOutbox.update({
      where: { id: id },
      data: {
        status: 'pending',
        attempts,
        nextAttemptAt: new Date(Date.now() + delaySec * 1000),
        lastError: errorMsg,
      },
    });
  }
}

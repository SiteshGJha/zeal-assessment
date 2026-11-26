import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpStatus, Injectable } from '@nestjs/common';
import { getWebhookSigningSecret } from '../auth/auth.types.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreateWebhookSubscriptionDto,
  VerifiedWebhookDelivery,
  WebhookSubscriptionDto,
} from './webhooks.dto.js';

const MAX_STORED_DELIVERIES = 100;
const TIMESTAMP_TOLERANCE_SEC = 300;

/**
 * Checks whether an IPv4 address belongs to private, loopback, link-local, or reserved ranges.
 */
function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * Checks whether an IPv6 address belongs to loopback, link-local, unique-local, or unspecified ranges.
 */
function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('::ffff:')) {
    const mapped = normalized.startsWith('::ffff:') ? normalized.slice(7) : '';
    if (mapped && isIP(mapped) === 4) {
      return isPrivateOrReservedIpv4(mapped);
    }
    return true;
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80')) {
    return true;
  }
  return false;
}

/**
 * Computes HMAC-SHA256 webhook signature header value.
 */
export function signWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `sha256=${digest}`;
}

/**
 * Manages webhook subscriptions, SSRF validation, and local verified delivery inspection.
 */
@Injectable()
export class WebhooksService {
  private readonly verifiedDeliveries: VerifiedWebhookDelivery[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async createSubscription(dto: CreateWebhookSubscriptionDto): Promise<WebhookSubscriptionDto> {
    await this.validateWebhookTargetUrl(dto.targetUrl);

    const created = await this.prisma.webhookSubscription.create({
      data: {
        targetUrl: dto.targetUrl,
        eventType: dto.eventType,
        secret: dto.secret,
        active: true,
      },
    });

    return {
      id: created.id,
      targetUrl: created.targetUrl,
      eventType: created.eventType as 'case.escalated',
      active: created.active,
      createdAt: created.createdAt.toISOString(),
    };
  }

  async receiveInternalWebhook(
    rawBody: string,
    payload: Record<string, unknown>,
    headers: {
      webhookId?: string;
      eventType?: string;
      timestamp?: string;
      signature?: string;
    },
  ): Promise<{ accepted: boolean }> {
    const { webhookId, eventType, timestamp, signature } = headers;
    if (!webhookId || !eventType || !timestamp || !signature) {
      throw new ProblemException(HttpStatus.UNAUTHORIZED, {
        title: 'Unauthorized',
        detail: 'Missing required webhook signature headers',
      });
    }

    const tsNum = Number.parseInt(timestamp, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > TIMESTAMP_TOLERANCE_SEC) {
      throw new ProblemException(HttpStatus.UNAUTHORIZED, {
        title: 'Unauthorized',
        detail: 'Webhook signature timestamp outside allowed replay window',
      });
    }

    let secret = getWebhookSigningSecret();
    const outbox = await this.prisma.webhookOutbox.findUnique({
      where: { id: webhookId },
      include: { subscription: true },
    });
    if (outbox?.subscription?.secret) {
      secret = outbox.subscription.secret;
    }

    const expected = signWebhookPayload(secret, timestamp, rawBody);
    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');

    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw new ProblemException(HttpStatus.UNAUTHORIZED, {
        title: 'Unauthorized',
        detail: 'Invalid webhook HMAC signature',
      });
    }

    this.verifiedDeliveries.unshift({
      webhookId,
      eventType,
      timestamp,
      payload,
      receivedAt: new Date().toISOString(),
    });
    if (this.verifiedDeliveries.length > MAX_STORED_DELIVERIES) {
      this.verifiedDeliveries.length = MAX_STORED_DELIVERIES;
    }

    return { accepted: true };
  }

  listDeliveries(): { items: VerifiedWebhookDelivery[] } {
    return { items: [...this.verifiedDeliveries] };
  }

  clearDeliveries(): void {
    this.verifiedDeliveries.length = 0;
  }

  private async validateWebhookTargetUrl(targetUrl: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
        title: 'Unprocessable Entity',
        detail: 'Invalid webhook targetUrl',
        errors: [{ field: 'targetUrl', message: 'targetUrl must be a valid URL' }],
      });
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
        title: 'Unprocessable Entity',
        detail: 'Unsupported webhook URL scheme',
        errors: [{ field: 'targetUrl', message: 'targetUrl must use http or https' }],
      });
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const isNonProd = process.env.NODE_ENV !== 'production';
    const isLocalLoopbackHost =
      hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';

    if (isNonProd && isLocalLoopbackHost) {
      return;
    }

    const ipFamily = isIP(hostname);
    if (ipFamily === 4) {
      if (isPrivateOrReservedIpv4(hostname)) {
        throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
          title: 'Unprocessable Entity',
          detail: 'Webhook targetUrl resolves to blocked private or reserved IP address',
          errors: [{ field: 'targetUrl', message: 'Private or reserved IP targets are blocked' }],
        });
      }
      return;
    }
    if (ipFamily === 6) {
      if (isPrivateOrReservedIpv6(hostname)) {
        throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
          title: 'Unprocessable Entity',
          detail: 'Webhook targetUrl resolves to blocked private or reserved IPv6 address',
          errors: [{ field: 'targetUrl', message: 'Private or reserved IP targets are blocked' }],
        });
      }
      return;
    }

    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await lookup(hostname, { all: true });
    } catch {
      throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
        title: 'Unprocessable Entity',
        detail: 'Unable to resolve webhook targetUrl hostname',
        errors: [{ field: 'targetUrl', message: 'Hostname resolution failed' }],
      });
    }

    for (const entry of resolved) {
      const blocked =
        entry.family === 4
          ? isPrivateOrReservedIpv4(entry.address)
          : isPrivateOrReservedIpv6(entry.address);
      if (blocked) {
        if (isNonProd && (entry.address === '127.0.0.1' || entry.address === '::1')) {
          continue;
        }
        throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
          title: 'Unprocessable Entity',
          detail: 'Webhook targetUrl resolves to blocked private or reserved IP range',
          errors: [{ field: 'targetUrl', message: 'Private or reserved IP targets are blocked' }],
        });
      }
    }
  }
}

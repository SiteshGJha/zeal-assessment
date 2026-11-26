import { Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { StructuredLoggerService } from '../common/logger.service.js';
import { RequestContext } from '../common/request-context.js';
import { CircuitBreaker } from './circuit-breaker.js';

export class UpstreamUnavailableError extends Error {
  constructor(
    public readonly upstream: string,
    message: string,
    public readonly statusCode = 503,
  ) {
    super(message);
    this.name = 'UpstreamUnavailableError';
  }
}

export interface RetryOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxJitterMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 150;
const DEFAULT_MAX_JITTER_MS = 50;
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_PRISMA_CODES = new Set(['P1001', 'P1008', 'P2024']);

/**
 * Computes jittered exponential backoff delay in milliseconds.
 */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxJitterMs = DEFAULT_MAX_JITTER_MS,
): number {
  const jitter = maxJitterMs > 0 ? Math.floor(Math.random() * (maxJitterMs + 1)) : 0;
  return baseDelayMs * 2 ** attempt + jitter;
}

/**
 * Checks whether a Prisma/PostgreSQL error represents a transient or statement-timeout failure.
 */
export function isRetryableSqlError(err: unknown): boolean {
  if (err instanceof UpstreamUnavailableError) {
    return RETRYABLE_HTTP_STATUSES.has(err.statusCode);
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (RETRYABLE_PRISMA_CODES.has(err.code)) {
      return true;
    }
    if (err.code === 'P2010') {
      const metaCode = typeof err.meta?.code === 'string' ? err.meta.code : '';
      return metaCode === '57014' || err.message.includes('57014');
    }
  }
  return err instanceof Error && err.message.includes('57014');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes upstream HTTP and SQL calls with bounded timeouts, jittered retries,
 * and per-upstream circuit breaking.
 */
@Injectable()
export class ResilienceExecutor {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly logger: StructuredLoggerService) {}

  getBreaker(upstream: string): CircuitBreaker {
    let breaker = this.breakers.get(upstream);
    if (!breaker) {
      breaker = new CircuitBreaker();
      this.breakers.set(upstream, breaker);
    }
    return breaker;
  }

  resetBreakers(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  async executeHttp(
    upstream: string,
    url: string,
    init: RequestInit = {},
    options: RetryOptions = {},
  ): Promise<Response> {
    const breaker = this.getBreaker(upstream);
    const ctx = RequestContext.get();
    const isSyntheticFault = Boolean(ctx?.faultInject.has(upstream));
    const shouldAffectBreaker = !isSyntheticFault || Boolean(ctx?.faultScopeCircuitBreaker);

    if (!breaker.canExecute()) {
      throw new UpstreamUnavailableError(upstream, `Circuit breaker OPEN for ${upstream}`);
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxJitterMs = options.maxJitterMs ?? DEFAULT_MAX_JITTER_MS;

    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (response.ok) {
          if (shouldAffectBreaker) {
            breaker.recordSuccess();
          }
          return response;
        }

        if (!RETRYABLE_HTTP_STATUSES.has(response.status) || attempt === maxRetries) {
          throw new UpstreamUnavailableError(
            upstream,
            `${upstream} returned HTTP ${response.status}`,
            response.status,
          );
        }

        lastError = new UpstreamUnavailableError(
          upstream,
          `${upstream} returned HTTP ${response.status}`,
          response.status,
        );
      } catch (err) {
        clearTimeout(timer);
        if (
          err instanceof UpstreamUnavailableError &&
          !RETRYABLE_HTTP_STATUSES.has(err.statusCode)
        ) {
          if (shouldAffectBreaker) {
            breaker.recordFailure();
          }
          throw err;
        }
        lastError = err;
        if (attempt === maxRetries) {
          if (shouldAffectBreaker) {
            breaker.recordFailure();
          }
          throw new UpstreamUnavailableError(
            upstream,
            `${upstream} request failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const backoffMs = computeBackoffMs(attempt, baseDelayMs, maxJitterMs);
      this.logger.warn('upstream_http_retry', {
        upstream,
        attempt: attempt + 1,
        backoffMs,
      });
      await sleep(backoffMs);
    }

    if (shouldAffectBreaker) {
      breaker.recordFailure();
    }
    throw new UpstreamUnavailableError(
      upstream,
      `${upstream} failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async executeSql<T>(
    upstream: string,
    prisma: PrismaClient,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: RetryOptions = {},
  ): Promise<T> {
    const breaker = this.getBreaker(upstream);
    const ctx = RequestContext.get();
    const faultDirective = ctx?.faultInject.get(upstream);
    const isSyntheticFault = Boolean(faultDirective);
    const shouldAffectBreaker = !isSyntheticFault || Boolean(ctx?.faultScopeCircuitBreaker);

    if (!breaker.canExecute()) {
      throw new UpstreamUnavailableError(upstream, `Circuit breaker OPEN for ${upstream}`);
    }

    const rawTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Number.isInteger(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxJitterMs = options.maxJitterMs ?? DEFAULT_MAX_JITTER_MS;

    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);

          if (faultDirective === 'timeout') {
            await tx.$executeRawUnsafe('SELECT pg_sleep(2)');
          } else if (faultDirective === '503') {
            throw new UpstreamUnavailableError(upstream, 'Simulated 503 fault', 503);
          } else if (faultDirective === '429') {
            throw new UpstreamUnavailableError(upstream, 'Simulated 429 fault', 429);
          } else if (faultDirective?.startsWith('delay:')) {
            const delayMs = Number.parseInt(faultDirective.slice('delay:'.length), 10);
            if (Number.isFinite(delayMs) && delayMs > 0) {
              const delaySec = Math.min(delayMs, 10_000) / 1000;
              await tx.$executeRawUnsafe(`SELECT pg_sleep(${delaySec})`);
            }
          }

          return fn(tx);
        });

        if (shouldAffectBreaker) {
          breaker.recordSuccess();
        }
        return result;
      } catch (err) {
        lastError = err;
        const retryable = isRetryableSqlError(err);
        if (!retryable || attempt === maxRetries) {
          if (shouldAffectBreaker) {
            breaker.recordFailure();
          }
          throw new UpstreamUnavailableError(
            upstream,
            `${upstream} SQL query failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const backoffMs = computeBackoffMs(attempt, baseDelayMs, maxJitterMs);
        this.logger.warn('upstream_sql_retry', {
          upstream,
          attempt: attempt + 1,
          backoffMs,
        });
        await sleep(backoffMs);
      }
    }

    if (shouldAffectBreaker) {
      breaker.recordFailure();
    }
    throw new UpstreamUnavailableError(
      upstream,
      `${upstream} SQL failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}

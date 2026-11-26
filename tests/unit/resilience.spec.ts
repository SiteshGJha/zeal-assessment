import { Prisma, type PrismaClient } from '@prisma/client';
import { StructuredLoggerService } from '../../src/common/logger.service.js';
import { RequestContext } from '../../src/common/request-context.js';
import { CircuitBreaker } from '../../src/resilience/circuit-breaker.js';
import {
  computeBackoffMs,
  isRetryableSqlError,
  ResilienceExecutor,
  UpstreamUnavailableError,
} from '../../src/resilience/resilience.executor.js';
import { canonicalizeAccountId } from '../../src/upstreams/upstream-clients.service.js';

describe('Resilience & Upstream Normalization Unit Tests', () => {
  it('transitions CircuitBreaker CLOSED -> OPEN -> HALF_OPEN -> CLOSED', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    expect(breaker.getState(0)).toBe('CLOSED');
    expect(breaker.canExecute(0)).toBe(true);

    breaker.recordFailure(100);
    breaker.recordFailure(200);
    expect(breaker.getState(200)).toBe('CLOSED');

    breaker.recordFailure(300);
    expect(breaker.getState(300)).toBe('OPEN');
    expect(breaker.canExecute(500)).toBe(false);

    // Cooldown elapsed -> single HALF_OPEN probe allowed
    expect(breaker.canExecute(1300)).toBe(true);
    expect(breaker.canExecute(1301)).toBe(false);

    breaker.recordSuccess();
    expect(breaker.getState(1305)).toBe('CLOSED');
  });

  it('returns to OPEN if HALF_OPEN probe fails', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 500 });
    breaker.recordFailure(100);
    breaker.recordFailure(200);
    expect(breaker.canExecute(700)).toBe(true);
    breaker.recordFailure(710);
    expect(breaker.getState(710)).toBe('OPEN');
    expect(breaker.canExecute(800)).toBe(false);
  });

  it('computes jittered exponential backoff within expected bounds', () => {
    for (let i = 0; i < 10; i += 1) {
      const d0 = computeBackoffMs(0, 150, 50);
      const d1 = computeBackoffMs(1, 150, 50);
      expect(d0).toBeGreaterThanOrEqual(150);
      expect(d0).toBeLessThanOrEqual(200);
      expect(d1).toBeGreaterThanOrEqual(300);
      expect(d1).toBeLessThanOrEqual(350);
    }
  });

  it('recognizes Prisma P2010 with 57014 statement_timeout as retryable SQL error', () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: `57014`. Message: canceling statement due to statement timeout',
      { code: 'P2010', clientVersion: '6.6.0', meta: { code: '57014' } },
    );
    expect(isRetryableSqlError(err)).toBe(true);

    const nonRetryable = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.6.0',
    });
    expect(isRetryableSqlError(nonRetryable)).toBe(false);
  });

  it('isolates synthetic X-Fault-Inject failures from shared circuit breaker unless scoped', async () => {
    const logger = new StructuredLoggerService();
    const executor = new ResilienceExecutor(logger);
    const mockPrisma = {
      $transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const fakeTx = { $executeRawUnsafe: jest.fn().mockResolvedValue(0) };
        return cb(fakeTx);
      }),
    } as unknown as PrismaClient;

    // 3 synthetic faults without X-Fault-Inject-Scope should NOT open the breaker
    for (let i = 0; i < 3; i += 1) {
      await expect(
        RequestContext.run(
          {
            correlationId: 'cid-1',
            faultInject: new Map([['snowflake', '503']]),
            faultScopeCircuitBreaker: false,
          },
          () =>
            executor.executeSql('snowflake', mockPrisma, async () => 'ok', {
              maxRetries: 0,
            }),
        ),
      ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    }
    expect(executor.getBreaker('snowflake').getState()).toBe('CLOSED');

    // With faultScopeCircuitBreaker: true, 3 failures trip the breaker to OPEN
    for (let i = 0; i < 3; i += 1) {
      await expect(
        RequestContext.run(
          {
            correlationId: 'cid-2',
            faultInject: new Map([['snowflake', '503']]),
            faultScopeCircuitBreaker: true,
          },
          () =>
            executor.executeSql('snowflake', mockPrisma, async () => 'ok', {
              maxRetries: 0,
            }),
        ),
      ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    }
    expect(executor.getBreaker('snowflake').getState()).toBe('OPEN');
  });

  it('canonicalizes legacy account IDs deterministically', () => {
    expect(canonicalizeAccountId('ACC-77')).toBe('ACC-007');
    expect(canonicalizeAccountId('acc-7')).toBe('ACC-007');
    expect(canonicalizeAccountId('ACC-007')).toBe('ACC-007');
    expect(canonicalizeAccountId('ACC-010')).toBe('ACC-010');
  });
});

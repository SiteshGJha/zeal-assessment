import {
  canonicalJson,
  computeIdempotencyRequestHash,
  parseStrongEtagVersion,
  PRIORITY_RANK,
} from '../../src/cases/cases.service.js';
import { ProblemException } from '../../src/common/problem-details.filter.js';
import { signWebhookPayload } from '../../src/webhooks/webhooks.service.js';

describe('Idempotency, Escalation & Webhook Signing Unit Tests', () => {
  it('produces identical SHA-256 request hashes regardless of JSON key ordering', () => {
    const h1 = computeIdempotencyRequestHash('POST', '/v1/cases/CS-10231/comments', 'user-1', {
      b: 2,
      a: { y: true, x: false },
    });
    const h2 = computeIdempotencyRequestHash('POST', '/v1/cases/CS-10231/comments', 'user-1', {
      a: { x: false, y: true },
      b: 2,
    });
    const h3 = computeIdempotencyRequestHash('POST', '/v1/cases/CS-10231/comments', 'user-2', {
      a: { x: false, y: true },
      b: 2,
    });

    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('enforces strong quoted ETag format for If-Match', () => {
    expect(parseStrongEtagVersion('"v1"')).toBe(1);
    expect(parseStrongEtagVersion('"v42"')).toBe(42);

    expect(() => parseStrongEtagVersion(undefined)).toThrow(ProblemException);
    try {
      parseStrongEtagVersion(undefined);
    } catch (err) {
      expect((err as ProblemException).getStatus()).toBe(428);
    }

    for (const invalid of ['v1', 'W/"v1"', '"1"', '""']) {
      try {
        parseStrongEtagVersion(invalid);
        fail(`Expected 412 for ${invalid}`);
      } catch (err) {
        expect((err as ProblemException).getStatus()).toBe(412);
      }
    }
  });

  it('orders case priority severity P1 > P2 > P3', () => {
    expect(PRIORITY_RANK.P1).toBeGreaterThan(PRIORITY_RANK.P2);
    expect(PRIORITY_RANK.P2).toBeGreaterThan(PRIORITY_RANK.P3);
  });

  it('computes deterministic HMAC-SHA256 webhook signatures', () => {
    const sig1 = signWebhookPayload('secret-1', '1700000000', '{"event":"test"}');
    const sig2 = signWebhookPayload('secret-1', '1700000000', '{"event":"test"}');
    const sigDiff = signWebhookPayload('secret-2', '1700000000', '{"event":"test"}');

    expect(sig1).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(sig1).toBe(sig2);
    expect(sig1).not.toBe(sigDiff);
  });
});

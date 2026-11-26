import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { seedDatabase } from '../../prisma/seed.js';
import { AppModule } from '../../src/app.module.js';
import { RateLimitGuard } from '../../src/common/rate-limit.guard.js';
import { createGlobalValidationPipe } from '../../src/main.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { ResilienceExecutor } from '../../src/resilience/resilience.executor.js';
import { mintToken } from '../../src/scripts/mint-token.js';
import { WebhookOutboxWorker } from '../../src/webhooks/webhook-outbox.worker.js';
import { WebhooksService } from '../../src/webhooks/webhooks.service.js';

describe('Platform API Integration (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rateLimitGuard: RateLimitGuard;
  let resilience: ResilienceExecutor;
  let outboxWorker: WebhookOutboxWorker;
  let webhooksService: WebhooksService;
  let baseUrl: string;

  const supportReadToken = mintToken({ role: 'support', sub: 'support-user-1' });
  const supportWriteToken = mintToken({ role: 'write', sub: 'support-writer-1' });
  const financeToken = mintToken({ role: 'finance', sub: 'finance-user-1' });

  beforeAll(async () => {
    process.env.MOCK_UPSTREAM_PORT = '0';
    process.env.FAULT_INJECTION_ENABLED = 'true';
    process.env.DISABLE_OUTBOX_WORKER = 'true';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(createGlobalValidationPipe());
    app.enableShutdownHooks();
    await app.init();

    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 3000;
    baseUrl = `http://127.0.0.1:${port}`;

    prisma = app.get(PrismaService);
    rateLimitGuard = app.get(RateLimitGuard);
    resilience = app.get(ResilienceExecutor);
    outboxWorker = app.get(WebhookOutboxWorker);
    webhooksService = app.get(WebhooksService);
  });

  beforeEach(async () => {
    rateLimitGuard.reset();
    resilience.resetBreakers();
    webhooksService.clearDeliveries();

    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE webhook_outbox, webhook_subscriptions, audit_logs, idempotency_records, case_comments, case_records, usage_metrics CASCADE',
    );
    await seedDatabase(prisma);
    await prisma.webhookSubscription.update({
      where: { id: 'sub-local-receiver' },
      data: { targetUrl: `${baseUrl}/internal/webhook-receiver` },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves GET /health without authentication', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'connected' });
  });

  it('aggregates customer entitlement and usage with finance:read scope gating ARR', async () => {
    const redactedRes = await request(app.getHttpServer())
      .get('/v1/customers/ACC-77')
      .set('Authorization', `Bearer ${supportReadToken}`)
      .expect(200);

    expect(redactedRes.body.accountId).toBe('ACC-007');
    expect(redactedRes.body.supportTier).toBe('Platinum');
    expect(redactedRes.body.arrUsd).toBeNull();
    expect(redactedRes.body.redactedFields).toEqual(['arrUsd']);
    expect(redactedRes.body.degraded).toBe(false);
    expect(redactedRes.body.usage).toEqual({
      month: '2026-09',
      protectedTb: 412.5,
      apiCalls: 1203331,
      activeUsers: 87,
    });
    expect(redactedRes.headers['x-correlation-id']).toBeDefined();
    expect(redactedRes.headers['ratelimit-limit']).toBe('60');

    const financeRes = await request(app.getHttpServer())
      .get('/v1/customers/ACC-007')
      .set('Authorization', `Bearer ${financeToken}`)
      .expect(200);

    expect(financeRes.body.arrUsd).toBe(480000);
    expect(financeRes.body.redactedFields).toEqual([]);
  });

  it('degrades gracefully when warehouse times out via X-Fault-Inject', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/customers/ACC-007')
      .set('Authorization', `Bearer ${financeToken}`)
      .set('X-Fault-Inject', 'snowflake=timeout')
      .expect(200);

    expect(res.body.degraded).toBe(true);
    expect(res.body.degradedReasons).toEqual(['usage_warehouse_unavailable']);
    expect(res.body.usage).toBeNull();
    expect(res.body.supportTier).toBe('Platinum');
  });

  it('falls back to NetSuite CSV when supplemental XML fails', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/customers/ACC-007')
      .set('Authorization', `Bearer ${financeToken}`)
      .set('X-Fault-Inject', 'netsuite-xml=503')
      .expect(200);

    expect(res.body.accountId).toBe('ACC-007');
    expect(res.body.degraded).toBe(false);
  });

  it('returns 503 ProblemDetails when primary NetSuite fails and 404 for unknown customer', async () => {
    const err503 = await request(app.getHttpServer())
      .get('/v1/customers/ACC-007')
      .set('Authorization', `Bearer ${supportReadToken}`)
      .set('X-Fault-Inject', 'netsuite=503')
      .expect(503);

    expect(err503.headers['content-type']).toContain('application/problem+json');
    expect(err503.headers['retry-after']).toBeDefined();
    expect(err503.body.status).toBe(503);

    const err404 = await request(app.getHttpServer())
      .get('/v1/customers/ACC-999')
      .set('Authorization', `Bearer ${supportReadToken}`)
      .expect(404);
    expect(err404.headers['content-type']).toContain('application/problem+json');
  });

  it('filters, sorts, and cursor-paginates GET /v1/cases', async () => {
    const page1 = await request(app.getHttpServer())
      .get('/v1/cases?sort=priority:desc&limit=2')
      .set('Authorization', `Bearer ${supportReadToken}`)
      .expect(200);

    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items[0].id).toBe('CS-10231');
    expect(page1.body.items[0].etag).toBe('v1');
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await request(app.getHttpServer())
      .get(`/v1/cases?sort=priority:desc&limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set('Authorization', `Bearer ${supportReadToken}`)
      .expect(200);

    expect(page2.body.items).toHaveLength(2);
    expect(page2.body.nextCursor).toBeNull();

    const p1OpenOver48h = await request(app.getHttpServer())
      .get('/v1/cases?status=open&priority=P1&minAgeHours=48')
      .set('Authorization', `Bearer ${supportReadToken}`)
      .expect(200);

    expect(p1OpenOver48h.body.items.map((c: { id: string }) => c.id)).toEqual(['CS-10231']);
  });

  it('enforces Idempotency-Key replay, concurrency race safety, and 409 mismatch on comments', async () => {
    const key = 'idem-comment-1';
    const first = await request(app.getHttpServer())
      .post('/v1/cases/CS-10231/comments')
      .set('Authorization', `Bearer ${supportWriteToken}`)
      .set('Idempotency-Key', key)
      .send({ body: 'Collected diagnostic bundle' })
      .expect(201);

    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(first.body.author).toBe('support-writer-1');

    const replay = await request(app.getHttpServer())
      .post('/v1/cases/CS-10231/comments')
      .set('Authorization', `Bearer ${supportWriteToken}`)
      .set('Idempotency-Key', key)
      .send({ body: 'Collected diagnostic bundle' })
      .expect(201);

    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);

    const conflict = await request(app.getHttpServer())
      .post('/v1/cases/CS-10231/comments')
      .set('Authorization', `Bearer ${supportWriteToken}`)
      .set('Idempotency-Key', key)
      .send({ body: 'Different payload under same key' })
      .expect(409);

    expect(conflict.headers['content-type']).toContain('application/problem+json');

    // Verify concurrent identical requests insert only 1 comment
    const [c1, c2] = await Promise.all([
      request(app.getHttpServer())
        .post('/v1/cases/CS-10232/comments')
        .set('Authorization', `Bearer ${supportWriteToken}`)
        .set('Idempotency-Key', 'idem-concurrent-1')
        .send({ body: 'Concurrent check' }),
      request(app.getHttpServer())
        .post('/v1/cases/CS-10232/comments')
        .set('Authorization', `Bearer ${supportWriteToken}`)
        .set('Idempotency-Key', 'idem-concurrent-1')
        .send({ body: 'Concurrent check' }),
    ]);

    expect(c1.status).toBe(201);
    expect(c2.status).toBe(201);
    expect(c1.body.id).toBe(c2.body.id);
    const dbComments = await prisma.caseComment.findMany({ where: { caseId: 'CS-10232' } });
    expect(dbComments).toHaveLength(1);
  });

  it('enforces If-Match ETag concurrency, business rules, and signed webhook outbox delivery', async () => {
    // Missing If-Match -> 428
    await request(app.getHttpServer())
      .post('/v1/cases/CS-10232/escalate')
      .set('Authorization', `Bearer ${supportWriteToken}`)
      .send({ reason: 'Customer SLA breached', targetPriority: 'P1' })
      .expect(428);

    // Stale/weak If-Match -> 412
    await request(app.getHttpServer())
      .post('/v1/cases/CS-10232/escalate')
      .set('Authorization', `Bearer ${supportWriteToken}`)
      .set('If-Match', '"v99"')
      .send({ reason: 'Customer SLA breached', targetPriority: 'P1' })
      .expect(412);

    // Escalate P2 -> P1 with matching If-Match -> 200 + ETag "v2"
    const escalated = await request(app.getHttpServer())
      .post('/v1/cases/CS-10232/escalate')
      .set('Authorization', `Bearer ${supportWriteToken}`)
      .set('If-Match', '"v1"')
      .send({ reason: 'Customer production cluster down', targetPriority: 'P1' })
      .expect(200);

    expect(escalated.headers.etag).toBe('"v2"');
    expect(escalated.body.status).toBe('escalated');
    expect(escalated.body.priority).toBe('P1');

    // Already escalated -> 422
    await request(app.getHttpServer())
      .post('/v1/cases/CS-10232/escalate')
      .set('Authorization', `Bearer ${supportWriteToken}`)
      .set('If-Match', '"v2"')
      .send({ reason: 'Duplicate escalation', targetPriority: 'P1' })
      .expect(422);

    // Run outbox worker once and inspect verified delivery
    const processed = await outboxWorker.runOnce();
    expect(processed).toBe(1);

    const deliveries = await request(app.getHttpServer())
      .get('/internal/webhook-deliveries')
      .set('Authorization', `Bearer ${supportReadToken}`)
      .expect(200);

    expect(deliveries.body.items).toHaveLength(1);
    expect(deliveries.body.items[0].eventType).toBe('case.escalated');
    expect(deliveries.body.items[0].payload.data.caseId).toBe('CS-10232');
  });

  it('rejects SSRF private webhook URLs in production and verifies scopes', async () => {
    await request(app.getHttpServer())
      .post('/v1/webhooks/subscriptions')
      .set('Authorization', `Bearer ${supportReadToken}`)
      .send({
        targetUrl: 'http://169.254.169.254/latest/meta-data',
        eventType: 'case.escalated',
        secret: 'super-secret-signing-key',
      })
      .expect(403);

    await request(app.getHttpServer())
      .post('/v1/webhooks/subscriptions')
      .set('Authorization', `Bearer ${supportWriteToken}`)
      .send({
        targetUrl: 'http://169.254.169.254/latest/meta-data',
        eventType: 'case.escalated',
        secret: 'super-secret-signing-key',
      })
      .expect(422);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import request from 'supertest';
import YAML from 'yaml';
import { seedDatabase } from '../../prisma/seed.js';
import { AppModule } from '../../src/app.module.js';
import { RateLimitGuard } from '../../src/common/rate-limit.guard.js';
import { createGlobalValidationPipe } from '../../src/main.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { ResilienceExecutor } from '../../src/resilience/resilience.executor.js';
import { mintToken } from '../../src/scripts/mint-token.js';
import { WebhookOutboxWorker } from '../../src/webhooks/webhook-outbox.worker.js';
import { WebhooksService } from '../../src/webhooks/webhooks.service.js';

describe('OpenAPI 3.1 Contract Tests', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rateLimitGuard: RateLimitGuard;
  let resilience: ResilienceExecutor;
  let outboxWorker: WebhookOutboxWorker;
  let webhooksService: WebhooksService;
  let baseUrl: string;
  let validateSchema: (schemaName: string, data: unknown) => void;

  const supportToken = mintToken({ role: 'support', sub: 'contract-support' });
  const writeToken = mintToken({ role: 'write', sub: 'contract-writer' });
  const financeToken = mintToken({ role: 'finance', sub: 'contract-finance' });

  beforeAll(async () => {
    const rawYaml = fs.readFileSync(path.resolve(process.cwd(), 'openapi.yaml'), 'utf8');
    const openapiDoc = YAML.parse(rawYaml) as Record<string, unknown>;

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema(openapiDoc, 'http://zeal.local/openapi.json');

    validateSchema = (schemaName: string, data: unknown) => {
      const validate = ajv.getSchema(
        `http://zeal.local/openapi.json#/components/schemas/${schemaName}`,
      );
      if (!validate) {
        throw new Error(`Missing schema #/components/schemas/${schemaName} in openapi.yaml`);
      }
      const valid = validate(data);
      if (!valid) {
        throw new Error(
          `Contract validation failed for ${schemaName}: ${ajv.errorsText(validate.errors)}`,
        );
      }
    };

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

  it('validates GET /v1/customers/{id} 200 (redacted, full, degraded) and ProblemDetails errors', async () => {
    const redactedRes = await request(app.getHttpServer())
      .get('/v1/customers/ACC-007')
      .set('Authorization', `Bearer ${supportToken}`)
      .expect(200);
    validateSchema('CustomerAggregate', redactedRes.body);
    expect(redactedRes.headers['x-correlation-id']).toBeTruthy();

    const financeRes = await request(app.getHttpServer())
      .get('/v1/customers/ACC-007')
      .set('Authorization', `Bearer ${financeToken}`)
      .expect(200);
    validateSchema('CustomerAggregate', financeRes.body);

    const degradedRes = await request(app.getHttpServer())
      .get('/v1/customers/ACC-007')
      .set('Authorization', `Bearer ${financeToken}`)
      .set('X-Fault-Inject', 'snowflake=timeout')
      .expect(200);
    validateSchema('CustomerAggregate', degradedRes.body);
    expect(degradedRes.body.degraded).toBe(true);

    const unauthRes = await request(app.getHttpServer()).get('/v1/customers/ACC-007').expect(401);
    expect(unauthRes.headers['content-type']).toContain('application/problem+json');
    validateSchema('ProblemDetails', unauthRes.body);

    const notFoundRes = await request(app.getHttpServer())
      .get('/v1/customers/ACC-404')
      .set('Authorization', `Bearer ${supportToken}`)
      .expect(404);
    validateSchema('ProblemDetails', notFoundRes.body);

    const unavailableRes = await request(app.getHttpServer())
      .get('/v1/customers/ACC-007')
      .set('Authorization', `Bearer ${supportToken}`)
      .set('X-Fault-Inject', 'netsuite=503')
      .expect(503);
    validateSchema('ProblemDetails', unavailableRes.body);
  });

  it('validates GET /v1/cases, POST /v1/cases/{id}/comments, POST /v1/cases/{id}/escalate, and ProblemDetails', async () => {
    const casesRes = await request(app.getHttpServer())
      .get('/v1/cases?sort=priority:desc&limit=10')
      .set('Authorization', `Bearer ${supportToken}`)
      .expect(200);
    validateSchema('CaseListResponse', casesRes.body);

    const invalidQueryRes = await request(app.getHttpServer())
      .get('/v1/cases?priority=P9')
      .set('Authorization', `Bearer ${supportToken}`)
      .expect(422);
    validateSchema('ProblemDetails', invalidQueryRes.body);

    const commentRes = await request(app.getHttpServer())
      .post('/v1/cases/CS-10231/comments')
      .set('Authorization', `Bearer ${writeToken}`)
      .set('Idempotency-Key', 'contract-cmt-1')
      .send({ body: 'Contract validation comment' })
      .expect(201);
    validateSchema('CaseCommentDto', commentRes.body);

    const conflictRes = await request(app.getHttpServer())
      .post('/v1/cases/CS-10231/comments')
      .set('Authorization', `Bearer ${writeToken}`)
      .set('Idempotency-Key', 'contract-cmt-1')
      .send({ body: 'Different payload triggers 409' })
      .expect(409);
    validateSchema('ProblemDetails', conflictRes.body);

    const forbiddenRes = await request(app.getHttpServer())
      .post('/v1/cases/CS-10232/escalate')
      .set('Authorization', `Bearer ${supportToken}`)
      .set('If-Match', '"v1"')
      .send({ reason: 'Forbidden scope check' })
      .expect(403);
    validateSchema('ProblemDetails', forbiddenRes.body);

    const missingEtagRes = await request(app.getHttpServer())
      .post('/v1/cases/CS-10232/escalate')
      .set('Authorization', `Bearer ${writeToken}`)
      .send({ reason: 'Missing If-Match header check' })
      .expect(428);
    validateSchema('ProblemDetails', missingEtagRes.body);

    const staleEtagRes = await request(app.getHttpServer())
      .post('/v1/cases/CS-10232/escalate')
      .set('Authorization', `Bearer ${writeToken}`)
      .set('If-Match', '"v99"')
      .send({ reason: 'Stale If-Match header check' })
      .expect(412);
    validateSchema('ProblemDetails', staleEtagRes.body);

    const escalateRes = await request(app.getHttpServer())
      .post('/v1/cases/CS-10232/escalate')
      .set('Authorization', `Bearer ${writeToken}`)
      .set('If-Match', '"v1"')
      .send({ reason: 'Contract escalation verification', targetPriority: 'P1' })
      .expect(200);
    validateSchema('CaseDto', escalateRes.body);
    expect(escalateRes.headers.etag).toBe('"v2"');

    await outboxWorker.runOnce();
    const deliveriesRes = await request(app.getHttpServer())
      .get('/internal/webhook-deliveries')
      .set('Authorization', `Bearer ${supportToken}`)
      .expect(200);
    expect(deliveriesRes.body.items.length).toBeGreaterThanOrEqual(1);
    validateSchema('CaseEscalatedWebhookPayload', deliveriesRes.body.items[0].payload);
  });

  it('validates POST /v1/webhooks/subscriptions against WebhookSubscriptionDto', async () => {
    const subRes = await request(app.getHttpServer())
      .post('/v1/webhooks/subscriptions')
      .set('Authorization', `Bearer ${writeToken}`)
      .send({
        targetUrl: `${baseUrl}/internal/webhook-receiver`,
        eventType: 'case.escalated',
        secret: 'contract-webhook-secret-1234',
      })
      .expect(201);
    validateSchema('WebhookSubscriptionDto', subRes.body);
  });
});

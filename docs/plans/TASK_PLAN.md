# Task Plan: Customer Entitlement & Support Case Platform API + MCP Server

## Delivery Checklist
- [x] **Phase 1 — Foundation, OpenAPI 3.1 Contract & Database Schema**:
  - `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `jest.config.ts`, `eslint.config.mjs`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `Makefile`
  - `openapi.yaml` (OpenAPI 3.1 contract with RFC 9457 `ProblemDetails` & webhook contract)
  - `prisma/schema.prisma`, `prisma/migrations/0001_init/migration.sql`, `prisma/seed.ts`, and `fixtures/` (`salesforce-cases.json`, `netsuite-entitlements.csv`, `netsuite-entitlements.xml`)
- [x] **Phase 2 — Core Middleware, Auth, Resilience & Loopback Upstreams**:
  - `src/auth/` (HS256 `JwtAuthGuard`, `ScopesGuard`, `@Public()`, `@Scopes()`), `src/scripts/mint-token.ts`
  - `src/common/` (`CorrelationMiddleware`, `StructuredLoggerService`, `RateLimitGuard`, `ProblemDetailsFilter`, `AuditInterceptor`, `@Global() CoreModule`)
  - `src/resilience/` (`CircuitBreaker`, `ResilienceExecutor`), `src/upstreams/` (`MockUpstreamServer`, `UpstreamClientsService`), `tests/unit/resilience.spec.ts`
- [x] **Phase 3 — REST Endpoints, Webhook Outbox & E2E Tests**:
  - `src/customers/`, `src/cases/`, `src/webhooks/`, `src/health/`, `src/app.module.ts`, `src/main.ts`
  - `tests/unit/idempotency-escalation.spec.ts`, `tests/integration/api.e2e-spec.ts`
- [x] **Phase 4 — MCP Server, Guardrails, Demo & Evals**:
  - `mcp/guardrails.ts`, `mcp/api-client.ts`, `mcp/server.ts`, `mcp/demo/run-demo.ts`, `mcp/demo/transcript.md`
  - `tests/unit/guardrails.spec.ts`, `tests/mcp/mcp-evals.spec.ts`
- [x] **Phase 5 — Contract Tests, Postman & Documentation**:
  - `tests/contract/openapi-contract.spec.ts`
  - `postman/zeal-platform.postman_collection.json`, `postman/zeal-local.postman_environment.json`
  - `DECISIONS.md`, `SECURITY.md`, `TESTEVALS.md`, `AI_USAGE.md`, `README.md`

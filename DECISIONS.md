# Architectural & Engineering Decisions

## 1. Platform Overview & Stack Selection
The **Customer Entitlement & Support Case Platform** exposes a contract-first HTTP REST API alongside a stdio Model Context Protocol (MCP) server for AI support copilots:
- **Runtime & Framework**: TypeScript + NestJS (Express adapter, `"module": "Node16"` CommonJS) provides clear modular boundaries (`auth`, `resilience`, `upstreams`, `customers`, `cases`, `webhooks`), declarative validation (`class-validator`), and centralized exception formatting (`ProblemDetailsFilter`).
- **Persistence**: PostgreSQL with **Prisma ORM** (single `public` schema, typed models mapped to snake-case tables `case_records`, `case_comments`, `idempotency_records`, `audit_logs`, `webhook_subscriptions`, `webhook_outbox`, `usage_metrics`). Using a single PostgreSQL database avoids Redis/MongoDB operational overhead while supporting atomic ACID transactions for idempotency records, optimistic ETag bumps, audit logs, and the transactional webhook outbox.
- **Mock Upstreams**: An internal `127.0.0.1` loopback HTTP server (`MockUpstreamServer`, supporting ephemeral `MOCK_UPSTREAM_PORT=0` in tests) serves `fixtures/salesforce-cases.json`, `fixtures/netsuite-entitlements.csv`, and `fixtures/netsuite-entitlements.xml` with `{{NOW_*}}` dynamic date offsets, while Snowflake usage metrics query the local `usage_metrics` PostgreSQL table via parameterized Prisma SQL (`$queryRaw`). This avoids hardcoded in-memory maps while remaining 100% deterministic offline.

## 2. API Style: REST vs. GraphQL vs. gRPC
- **Chosen**: **Contract-first REST + JSON (`openapi.yaml`, OpenAPI 3.1)** with RFC 9457 `application/problem+json` errors.
- **Why not GraphQL**:
  - GraphQL complicates HTTP-level optimistic concurrency (`If-Match` ETags), `Idempotency-Key` semantics, and per-route OAuth scope enforcement (`finance:read` vs `support:write`).
  - Unbounded nested queries introduce query-complexity and over-fetching vectors when bridging legacy ERP/CRM sources.
- **Why not gRPC**:
  - External partner integrations, webhook consumers, `curl`, and Postman workflows expect standard HTTP/JSON semantics, human-readable Problem Details, and zero-codegen client onboarding.
  - Internal upstream adapters sit behind `UpstreamClientsService`, allowing internal gRPC migration later without changing external REST contracts.

## 3. MCP Tool Design vs. Direct REST Exposure
Rather than blindly mirroring every REST header/parameter or exposing raw database/SQL access to an LLM, `mcp/server.ts` provides four task-oriented, strictly bounded tools (`search_cases`, `get_customer_summary`, `add_case_comment`, `escalate_case`) backed by `McpApiClient`:
- **Context Budget & Safety Caps**: Tool schemas restrict `limit <= 20` (default `10`), truncate free-form text to 500 chars, and pop trailing records if serialized JSON exceeds `8,192` bytes (`truncated: true`, `nextCursor: null`).
- **Out-of-Band Human-in-the-Loop (HITL) Confirmation**: State-changing escalations (`escalate_case`) return `{ status: 'CONFIRMATION_REQUIRED', preview }` unless `MCP_ALLOW_ESCALATE_EXECUTION === 'true'` and `confirmed === true`. In the default host configuration (`MCP_ALLOW_ESCALATE_EXECUTION=false`), prompt injections inside untrusted customer text cannot trigger silent escalations even if the model calls `escalate_case` with `confirmed: true`.

## 4. Consistency, Resilience & Security Trade-Offs
- **Idempotency + Concurrency**: `POST /v1/cases/:id/comments` records `(scopeKey, idempotencyKey, requestHash)` in PostgreSQL inside a transaction, replaying identical requests with `Idempotent-Replayed: true` and rejecting hash mismatches with HTTP `409` (`ProblemDetails`).
- **Optimistic Locking**: `POST /v1/cases/:id/escalate` requires a strong `If-Match: "\"vN\""` header (returning `428` if missing, `412` on weak/stale ETag) and checks `updateMany({ where: { id, version: expectedVersion } })` plus business rules (`open` status only, priority must escalate monotonically -> `422` otherwise).
- **Bounded Resilience (`ResilienceExecutor`)**:
  - `netsuite` (CSV primary) fails closed with `503` + `Retry-After: 5` when circuit-open or exhausted.
  - `netsuite-xml` (supplemental metadata) degrades to primary CSV (`netsuite_xml_fallback_to_csv`).
  - `snowflake` (SQL telemetry) retries transient timeouts and degrades gracefully (`degraded: true`, `degradedReasons: ['usage_warehouse_unavailable']`) so customer support workflows remain available.
- **Dual LLM Demo Mode**: `mcp/demo/run-demo.ts` supports live OpenRouter tool-calling (`baidu/ernie-5.5-flash-preview:free` with automatic fallback to `meta-llama/llama-3.3-70b-instruct:free` on HTTP failure, timeout, or invalid tool-call JSON) alongside a zero-key `--mode=deterministic` workflow and a recorded transcript (`mcp/demo/transcript.md`).

## 5. Intentionally Skipped for Take-Home Scope & Production Scaling Path
- **Process-Local Sliding-Window Rate Limiter (`RateLimitGuard`)**: Uses an in-memory 60-second sliding window (`60` req / `60s` per `actorSub`, plus `30` req / `60s` per `(actorSub, agentId)` when `X-Agent-Id` is sent) with `RateLimit-*` headers; production multi-replica deployments should swap in a Redis atomic Lua / token-bucket store.
- **In-process Outbox Poller (`WebhookOutboxWorker`)**: Polls `webhook_outbox` cleanly on a timer with exponential retry (`attempts < 5`); production scale would move dispatch to dedicated worker replicas or `LISTEN/NOTIFY` / Debezium CDC + message broker.
- **Symmetric HS256 JWT (`JWT_SECRET`)**: Simplifies local minting (`npm run token:mint`) and automated tests; production should verify asymmetric RS256/ES256 tokens via an OIDC JWKS endpoint.
- **Mock Upstreams & Static SSRF Host Checks**: Production connectors would talk directly to Salesforce/NetSuite/Snowflake over mTLS/OAuth and route outbound webhooks through a DNS-pinning egress proxy to defend against DNS rebinding.

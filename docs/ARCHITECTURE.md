# Architecture Reference — Customer Entitlement & Support Case Platform

This document describes the implemented system architecture, runtime pipelines, data model, resilience patterns, transactional write guarantees, and MCP AI guardrail flows based directly on the codebase.

---

## 1. System Context & Container Topology

```mermaid
flowchart TB
  subgraph Clients["External Clients & AI Agents"]
    HTTP["HTTP Clients (curl / Postman / Partner Apps)"]
    LLM["AI Copilot Host (mcp/demo/run-demo.ts / OpenRouter)"]
  end

  subgraph MCP["MCP Boundary (stdio JSON-RPC)"]
    MCPServer["MCP Server (mcp/server.ts)"]
    Guardrails["Guardrails (mcp/guardrails.ts)\nXML delimiters, PII scrub, <8KB, HITL gate"]
    ApiClient["McpApiClient (mcp/api-client.ts)"]
  end

  subgraph API["NestJS Platform API (src/main.ts :3000)"]
    Pipeline["Global Middleware, Guards & Interceptors"]
    Customers["CustomersModule"]
    Cases["CasesModule"]
    Webhooks["WebhooksModule + WebhookOutboxWorker"]
    Health["HealthController (/health)"]
    Resilience["ResilienceExecutor + CircuitBreaker"]
  end

  subgraph Data["PostgreSQL & Local Loopback Stubs"]
    PG[("PostgreSQL (Prisma ORM)\ncase_records, case_comments,\nidempotency_records, audit_logs,\nwebhook_subscriptions, webhook_outbox,\nusage_metrics")]
    Mock["MockUpstreamServer (127.0.0.1:3001)\nsalesforce-cases.json\nnetsuite-entitlements.csv / .xml"]
  end

  HTTP -->|"HTTPS / HTTP + Bearer JWT"| Pipeline
  LLM <-->|"stdio JSON-RPC"| MCPServer
  MCPServer <--> Guardrails
  MCPServer --> ApiClient
  ApiClient -->|"HTTP + JWT + X-Agent-Id + X-Correlation-ID"| Pipeline
  LLM -.->|"Out-of-band human approval -> Direct REST POST"| Pipeline

  Pipeline --> Customers
  Pipeline --> Cases
  Pipeline --> Webhooks
  Pipeline --> Health

  Customers --> Resilience
  Cases --> Resilience
  Cases --> PG
  Webhooks --> PG
  Webhooks -->|"HMAC-SHA256 Webhook POST"| HTTP
  Health --> PG

  Resilience -->|"executeHttp (1500ms timeout, 2 retries)"| Mock
  Resilience -->|"executeSql (SET LOCAL statement_timeout)"| PG
```

---

## 2. NestJS Request Processing Pipeline

Global bindings in [app.module.ts](../src/app.module.ts) and [main.ts](../src/main.ts) enforce cross-cutting telemetry, security, validation, and RFC 9457 error formatting on every request.

```mermaid
flowchart LR
  Req["Incoming HTTP Request"] --> Corr["CorrelationMiddleware\nX-Correlation-ID + X-Fault-Inject\nAsyncLocalStorage RequestContext"]
  Corr --> Jwt["JwtAuthGuard (APP_GUARD)\nSkips @Public()\nVerifies HS256 JWT + sanitizes X-Agent-Id"]
  Jwt --> Scopes["ScopesGuard (APP_GUARD)\nChecks @RequiredScopes(...)"]
  Scopes --> Rate["RateLimitGuard (APP_GUARD)\n60s sliding window:\n60/min user + 30/min agent"]
  Rate --> Pipe["ValidationPipe\ntransform + whitelist +\nforbidNonWhitelisted -> 422"]
  Pipe --> AuditIn["AuditInterceptor (APP_INTERCEPTOR)\nRecords /v1/* outcome to audit_logs"]
  AuditIn --> Handler["Controller & Service Handler"]
  Handler --> Resp["HTTP Response + RateLimit-* + X-Correlation-ID"]
  Handler -.->|"Any HttpException / Error"| Filter["ProblemDetailsFilter (APP_FILTER)\napplication/problem+json (RFC 9457)"]
```

Key implementation invariants:
- `RateLimitGuard` is registered as an explicit provider and bound via `{ provide: APP_GUARD, useExisting: RateLimitGuard }` so all requests and tests share the same bucket registry.
- `CorrelationMiddleware` attaches `res.on('finish', ...)` to emit single-line structured JSON `http_request` logs via `StructuredLoggerService` including `correlationId`, `actorSub`, `agentId`, `status`, and `durationMs`.
- `NestFactory.create(AppModule, { rawBody: true })` preserves raw request bytes for constant-time HMAC signature verification (`timingSafeEqual`) on `POST /internal/webhook-receiver`.

---

## 3. PostgreSQL Data Model (Prisma ORM)

Defined in [schema.prisma](../prisma/schema.prisma) and initialized via [0001_init/migration.sql](../prisma/migrations/0001_init/migration.sql):

```mermaid
erDiagram
  CASE_RECORDS ||--o{ CASE_COMMENTS : "has comments"
  WEBHOOK_SUBSCRIPTIONS ||--o{ WEBHOOK_OUTBOX : "enqueues deliveries"

  CASE_RECORDS {
    string id PK
    string status
    string priority
    int version
    datetime updated_at
  }

  CASE_COMMENTS {
    string id PK "UUID"
    string case_id FK
    string author
    string body
    datetime created_at
  }

  IDEMPOTENCY_RECORDS {
    string id PK "UUID"
    string idempotency_key "Composite Unique"
    string method "Composite Unique"
    string path "Composite Unique"
    string actor_sub "Composite Unique"
    string request_hash "SHA-256"
    int status_code
    json response_body
    datetime created_at
  }

  AUDIT_LOGS {
    string id PK "UUID"
    string correlation_id
    string actor_sub
    string agent_id "nullable"
    string action
    string resource_type
    string resource_id
    string[] scopes
    string outcome "success | denied | error"
    json metadata
    datetime created_at
  }

  WEBHOOK_SUBSCRIPTIONS {
    string id PK "UUID"
    string event_type
    string target_url
    string secret
    boolean active
    datetime created_at
  }

  WEBHOOK_OUTBOX {
    string id PK "UUID"
    string subscription_id FK
    string event_type
    json payload
    string status "pending | processing | delivered | failed"
    int attempts
    datetime next_attempt_at
    string last_error "nullable"
    datetime created_at
    datetime delivered_at "nullable"
  }

  USAGE_METRICS {
    string account_id PK "Composite PK"
    string month PK "Composite PK"
    float protected_tb
    int api_calls
    int active_users
  }
```

### Upstream Overlay Pattern
Support cases combine static fixture records from Salesforce (`MockUpstreamServer /mock/salesforce/cases`) with transactional PostgreSQL overlays in `case_records` and `case_comments`. `CasesService.mergeCaseWithOverlay` deduplicates comments by `id`, sorts chronologically, and exposes PostgreSQL `version` as `etag` (`"v1"`, `"v2"`, etc.).

---

## 4. Resilience, Fault Injection & Graceful Degradation

### Circuit Breaker Lifecycle ([circuit-breaker.ts](../src/resilience/circuit-breaker.ts))

```mermaid
stateDiagram-v2
  [*] --> CLOSED
  CLOSED --> OPEN : consecutiveFailures >= 3
  OPEN --> HALF_OPEN : nowMs - openedAtMs >= 15000ms
  HALF_OPEN --> CLOSED : single probe succeeds
  HALF_OPEN --> OPEN : single probe fails
```

- **Timeouts & Retries** ([resilience.executor.ts](../src/resilience/resilience.executor.ts)):
  - HTTP upstreams (`salesforce`, `netsuite`, `netsuite-xml`): `1500ms` `AbortController` timeout, `maxRetries = 2`, retryable statuses `{429, 502, 503, 504}`, backoff `150 * 2^attempt + random(0..50) ms`.
  - SQL upstream (`snowflake`): `SET LOCAL statement_timeout = 1500` inside `prisma.$transaction(...)`, `maxRetries = 2`, retryable Prisma codes `{P1001, P1008, P2024}` or PostgreSQL SQLSTATE `57014`.
  - Synthetic faults injected via `X-Fault-Inject` do not trip shared circuit breakers unless `X-Fault-Inject-Scope: circuit-breaker` is also sent (when `FAULT_INJECTION_ENABLED=true`).

### Customer Aggregation & Degradation Flow (`GET /v1/customers/:id`)

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant S as CustomersService
  participant U as UpstreamClientsService
  participant NS as Mock NetSuite (CSV + XML)
  participant SF as Snowflake SQL (usage_metrics)

  C->>S: GET /v1/customers/ACC-77?includeUsage=true
  S->>U: canonicalizeAccountId("ACC-77") -> "ACC-007"
  par NetSuite Primary CSV & Supplemental XML
    U->>NS: GET /mock/netsuite/entitlements.csv (resilient)
    U->>NS: GET /mock/netsuite/entitlements.xml (resilient, catches errors)
  and Snowflake Usage Telemetry (when includeUsage=true)
    U->>SF: SELECT ... FROM usage_metrics LIMIT 1 (1500ms timeout)
  end

  alt Primary CSV fails / Circuit OPEN
    U--xS: UpstreamUnavailableError
    S-->>C: 503 ProblemDetails + Retry-After: 5
  else XML fails or mismatches CSV
    U-->>S: Logs netsuite_xml_fallback_to_csv / csv_wins; returns CSV row
  end

  alt Snowflake times out / fails
    SF--xU: UpstreamUnavailableError
    U--xS: degraded = true, degradedReasons = ["usage_warehouse_unavailable"]
  end

  alt finance:read absent in JWT scopes
    S-->>C: 200 CustomerAggregate (arrUsd: null, redactedFields: ["arrUsd"])
  else finance:read present
    S-->>C: 200 CustomerAggregate (arrUsd: 480000, redactedFields: [])
  end
```

---

## 5. Idempotency, Optimistic Concurrency & Webhook Outbox

### Idempotent Comment Creation (`POST /v1/cases/:id/comments`)
1. `CasesService.addComment` validates `Idempotency-Key` (non-empty, `<= 128` chars) -> `400` if missing/invalid.
2. `computeIdempotencyRequestHash` computes SHA-256 over `POST:${path}:${actorSub}:${canonicalJson(dto)}`.
3. Inside `prisma.$transaction`: ensures `CaseRecord` overlay exists (`skipDuplicates: true`), creates `CaseComment`, and inserts `IdempotencyRecord`.
4. On concurrent or repeated key (`PrismaClientKnownRequestError P2002`): fetches the persisted `IdempotencyRecord` and compares `requestHash`. Equal hashes replay the stored `201` JSON with header `Idempotent-Replayed: true`; mismatched hashes throw `409 Conflict`.

### Optimistic Escalation & Outbox Dispatch (`POST /v1/cases/:id/escalate`)

```mermaid
sequenceDiagram
  autonumber
  participant C as Client / Host
  participant API as CasesService
  participant DB as PostgreSQL
  participant W as WebhookOutboxWorker
  participant R as Webhook Subscriber

  C->>API: POST /v1/cases/CS-10232/escalate (If-Match: "v1")
  API->>API: parseStrongEtagVersion -> 428 missing / 412 weak or invalid
  API->>DB: BEGIN TRANSACTION
  API->>DB: Ensure case_records row & read current version/status
  alt Version mismatch
    API-->>C: 412 Precondition Failed
  else status != "open" or targetPriority <= currentPriority
    API-->>C: 422 Unprocessable Entity
  else Valid transition
    API->>DB: UPDATE case_records SET status='escalated', version=version+1 WHERE version=1
    API->>DB: INSERT INTO webhook_outbox (pending rows for active subscriptions)
    API->>DB: COMMIT
    API-->>C: 200 CaseDto + ETag: "v2"
  end

  loop Every 1000ms (unless DISABLE_OUTBOX_WORKER=true)
    W->>DB: Claim up to 10 pending rows (status -> processing)
    W->>R: POST targetUrl + X-Webhook-* + X-Signature-SHA256 (3s timeout)
    alt 2xx OK
      W->>DB: status='delivered', delivered_at=now
    else Non-2xx or network error
      W->>DB: Requeue with backoff [1,4,16,64]s or status='failed' after 5 attempts
    end
  end
```

---

## 6. MCP Server, Guardrails & Out-of-Band Human Confirmation

The MCP server ([mcp/server.ts](../mcp/server.ts)) runs as a `stdio` JSON-RPC child process rather than directly touching PostgreSQL or bypassing REST scopes.

```mermaid
sequenceDiagram
  autonumber
  participant H as Copilot Host / LLM Loop
  participant M as MCP Server (dist/mcp/server.js)
  participant G as Guardrails (mcp/guardrails.ts)
  participant API as Platform REST API

  H->>M: tools/call search_cases / get_customer_summary
  M->>API: GET /v1/cases or /v1/customers/:id (JWT + X-Agent-Id + X-Correlation-ID)
  API-->>M: Raw JSON response (may contain injected prompt text & PII)
  M->>G: stripControlAndTags -> scrubPii -> wrapUntrustedData -> <8KB trim
  G-->>M: Sanitized JSON (<untrusted_case_data>...</untrusted_case_data>)
  M-->>H: Tool result (stderr only for audit logs)

  H->>M: tools/call escalate_case (caseId, expectedEtag, reason, confirmed?)
  M->>G: evaluateEscalationGate(args, process.env)
  alt MCP_ALLOW_ESCALATE_EXECUTION != "true" (default)
    G-->>M: CONFIRMATION_REQUIRED + sanitized preview
    M-->>H: Tool response { status: "CONFIRMATION_REQUIRED", preview }
    H->>H: Operator prompt [y/N] or --auto-confirm
    H->>API: Direct host POST /v1/cases/:id/escalate (If-Match: "\"v1\"")
    API-->>H: 200 CaseDto (etag: "v2")
  end
```

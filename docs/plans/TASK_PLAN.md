# Task Plan: Customer Entitlement & Support Case Platform API

Based on **Senior AI API Platform Engineer (G7) – Take-Home Assignment**.

## 1. Overview & Architecture

Internal teams (Support, Finance, Customer Success) need a unified **Customer Entitlement & Support Case API** that serves both:
1. **Traditional Apps/API** (iPaaS/MuleSoft, frontends, automated workflows).
2. **AI Agents** (an internal "Support Copilot" answering complex entitlement/case queries and executing authorized actions via MCP).

### Upstream Systems (Mocked/Stubbed)
- **Case System (e.g. Salesforce)**: SaaS REST — cases, comments, status, priority, timestamps.
- **Entitlement System (e.g. NetSuite)**: SaaS REST / CSV export / XML feed — customer accounts, contracts, support tier (Platinum/Gold/Silver), renewal date, ARR.
- **Usage Warehouse (e.g. Snowflake)**: SQL / in-memory store — per-customer product usage metrics (protected_tb, api_calls, active_users).

---

## 2. Acceptance Criteria & Edge Cases

### Part A: Contract-First API Design (`openapi.yaml`)
- [ ] Contract-first OpenAPI 3.1 specification.
- [ ] `GET /v1/customers/{id}`: Aggregated view combining entitlement + usage summary. Returns `degraded: true` with cached/partial data if usage warehouse is down.
- [ ] `GET /v1/cases`: Case search with filtering (`status`, `priority`, `accountId`), sorting, and cursor-based pagination.
- [ ] `POST /v1/cases/{id}/comments`: Idempotent comment creation using `Idempotency-Key` header.
- [ ] `POST /v1/cases/{id}/escalate`: State transition enforcing business rules (e.g. only open cases, valid escalation reasons, priority validation).
- [ ] Webhook specification: `case.escalated` event definition with HMAC-SHA256 signature verification (`X-Signature-SHA256`).
- [ ] RFC 9457 compliant error handling (`application/problem+json`).
- [ ] Scoped AuthN/AuthZ (e.g. `support:read`, `support:write`, `finance:read` for sensitive ARR data).
- [ ] Rate limiting headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`).

### Part B: Resilient Core Implementation
- [ ] Single-command execution (`docker compose up` or `npm run dev`).
- [ ] Persistent store (SQLite or PostgreSQL) for idempotency keys, audit logs, and webhook event outbox.
- [ ] Resilient upstream integrations:
  - Configurable timeouts (e.g. 1.5s).
  - Exponential backoff retries with jitter for transient errors (5xx/timeouts).
  - Circuit breaker / fallback for upstream degradation.
- [ ] Structured logging with correlation IDs (`X-Correlation-ID`) propagated throughout upstream calls.
- [ ] Comprehensive test suite: unit tests, integration tests, contract tests against OpenAPI spec.
- [ ] Postman collection with functional and regression test suites.

### Part C: AI & MCP Enablement (`mcp/`)
- [ ] MCP Server (stdio and/or HTTP/SSE) implementing the Model Context Protocol.
- [ ] Dedicated agent tools:
  - `search_cases`: Read tool with rich filters and compact token response.
  - `get_customer_summary`: Read tool summarizing tier, ARR, health, open cases.
  - `add_case_comment`: Write tool with idempotency and audit trail.
  - `escalate_case`: High-risk write tool requiring human-in-the-loop confirmation.
- [ ] Guardrails & Security:
  - Auth context propagation (user identity and scopes flowing through MCP to API).
  - PII and sensitive data redaction (masking financial ARR from non-finance agents).
  - Protection against prompt injection in case comments / ticket descriptions.
  - Per-agent rate limiting and tamper-proof audit logging.
- [ ] Evaluation Suite (`TESTEVALS.md`) with scenario testing (including the Section 2 benchmark query: *"Which Platinum customers have P1 cases open for more than 48 hours and a renewal in the next 90 days?"*).
- [ ] Demo script demonstrating agent execution, tool calls, and failure recovery.

---

## 3. Required Deliverables Matrix

| File | Status | Description |
|---|---|---|
| `README.md` | Pending | Quickstart, architecture overview, how to run & demo in < 5 minutes |
| `openapi.yaml` | Pending | Complete OpenAPI 3.1 contract per Part A requirements |
| `src/` & `tests/` | Pending | Implementation, upstream mocks, resilient clients, and tests |
| `mcp/` | Pending | Model Context Protocol server, tools, guardrails, and demo script |
| `postman/` | Pending | Postman collection & environment for API testing |
| `TESTEVALS.md` | Pending | Evaluation dataset and scenario results |
| `SECURITY.md` | Pending | Threat modeling, guardrails, auth propagation, prompt injection protection |
| `DECISIONS.md` | Pending | Architecture trade-offs, technology choices, REST vs GraphQL/gRPC analysis |
| `AI_USAGE.md` | Pending | Transparency log of AI assistant usage, errors encountered, and verification |

---

## 4. Implementation Checklist

- [x] Phase 0: Repository Initialization & Task Plan Setup
  - [x] Git repository initialization
  - [x] Base `.gitignore` and planning docs
- [ ] Phase 1: API Contract & OpenAPI Specification (`openapi.yaml`)
  - [ ] Define schemas (Customer, Entitlement, Usage, Case, Comment, Escalation, ProblemDetails)
  - [ ] Define endpoints with security scopes and headers
  - [ ] Define webhook payload and signature headers
- [ ] Phase 2: Upstream Mocks & Resilient API Platform (`src/`)
  - [ ] Stub Salesforce, NetSuite, and Snowflake data sources
  - [ ] Build resilient integration layer (timeout, retry, circuit breaker)
  - [ ] Build API endpoints with RFC 9457 errors and idempotency
  - [ ] Add structured logging with correlation IDs
- [ ] Phase 3: Automated Testing & Postman Export
  - [ ] Unit & contract tests
  - [ ] Postman collection with regression checks
- [ ] Phase 4: MCP Server & AI Enablement (`mcp/`)
  - [ ] Implement MCP tools with strict schemas
  - [ ] Implement guardrails, redaction, and prompt injection filters
  - [ ] Build demo runner for the benchmark scenario
  - [ ] Run evaluations and record `TESTEVALS.md`
- [ ] Phase 5: Documentation & Governance
  - [ ] Complete `DECISIONS.md`, `SECURITY.md`, `AI_USAGE.md`, and `README.md`

# AI Usage Disclosure & Engineering Log

AI assistance (Antigravity coding agent) was used iteratively throughout design, implementation, and verification under human review and explicit architectural decisions.

## 1. Where AI Assisted
- **Architecture & Design Review**: Structured the multi-perspective design document (`docs/designs/customer-entitlement-support-api.md`) covering API contracts, Prisma schema, resilience thresholds, and security boundaries.
- **Boilerplate & Implementation**: Generated NestJS modules (`auth`, `common`, `prisma`, `resilience`, `upstreams`, `customers`, `cases`, `webhooks`), OpenAPI 3.1 contract (`openapi.yaml`), MCP server/guardrails (`mcp/`), Postman collection/environment, and unit/E2E/contract/MCP test suites.
- **Test-Driven Verification & Diagnosis**: Diagnosed and resolved real integration defects surfaced by running live tests:
  1. `Nest could not find RateLimitGuard` during `AppModule` E2E bootstrap -> switched `AppModule` from `{ provide: APP_GUARD, useClass: RateLimitGuard }` to registering `RateLimitGuard` plus `{ provide: APP_GUARD, useExisting: RateLimitGuard }` so E2E resets operate on the live guard singleton.
  2. Live `mcp-evals.spec.ts` failure on adversarial case `CS-10235` -> caught that `GET /v1/cases` returns `comments[].body` rather than a synthetic `latestCommentSnippet` field and that `mcp/server.ts` query enums differed from `ListCasesQueryDto`; aligned schemas and added recursive comment-body `<untrusted_case_data>` sanitization in `mcp/guardrails.ts`.
  3. ESLint `no-control-regex` violation on `mcp/guardrails.ts` -> replaced control-character regex with an explicit char-code filter (`removeControlChars`).

## 2. Human Decisions & Verification Ownership
- Selected **Prisma ORM + PostgreSQL** over raw SQL-only setup and opted for an **out-of-band confirmation gate** on `escalate_case` instead of crypto-signed approval tokens passed back through LLM context.
- Selected dual demo execution with **OpenRouter** (`baidu/ernie-5.5-flash-preview:free` primary / `meta-llama/llama-3.3-70b-instruct:free` fallback) alongside a **zero-key deterministic harness** and recorded transcript.
- Every test suite (`npm run lint`, `npm test`, `npm run test:contract`, `npm run test:e2e`, `npm run test:mcp`, and `npm run demo:mcp`) was executed directly against live PostgreSQL and NestJS processes after final edits.

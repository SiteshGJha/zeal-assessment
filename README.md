# Customer Entitlement & Support Case Platform

Contract-first NestJS REST API, PostgreSQL/Prisma persistence layer, bounded loopback upstream stubs, and guarded MCP server (`stdio`) for AI support copilots.

## Architecture Overview

```text
  HTTP / Postman / curl              AI Copilot / Demo Harness
           │                                   │ (stdio JSON-RPC)
           ▼                                   ▼
   NestJS REST API (openapi.yaml) ◄──── MCP Server (dist/mcp/server.js)
     ├─ AuthN/Z (HS256 JWT + Scopes)      ├─ Sanitization (<untrusted_case_data>)
     ├─ ResilienceExecutor + Breakers     ├─ PII Scrubbing & <8KB Cap
     ├─ Case & Webhook Outbox (Prisma)    └─ Out-of-Band HITL Confirmation
           │
     ┌─────┴──────────────────┬────────────────────────┐
     ▼                        ▼                        ▼
PostgreSQL (Prisma)   Loopback Stub (127.0.0.1)   Snowflake SQL Stub
case_records/comments salesforce-cases.json       usage_metrics table
idempotency_records   netsuite-entitlements.csv   (parameterized $queryRaw)
webhook_outbox        netsuite-entitlements.xml
```

## Quickstart (< 5 Minutes)

### Option A: Docker Compose (Recommended when Docker daemon is running)
```bash
cp -n .env.example .env
docker compose up --build
```
Wait for `api` healthcheck (`http://127.0.0.1:3000/health`), then seed initial sample fixtures if running interactively or run the MCP demo against `http://127.0.0.1:3000`:
```bash
npm run demo:mcp -- --mode=deterministic --auto-confirm
```

### Option B: Local Node.js + PostgreSQL
1. Install dependencies & configure `.env`:
   ```bash
   cp -n .env.example .env
   npm install
   ```
   Ensure `DATABASE_URL` in `.env` points to a running PostgreSQL database (for example `postgresql://zeal:zeal@localhost:5432/zeal_platform`).
2. Generate Prisma client, migrate schema, build TypeScript, and seed deterministic data:
   ```bash
   npm run prisma:generate
   npm run prisma:migrate
   npm run build
   npm run prisma:seed
   ```
3. Start the API server (starts both REST HTTP on `PORT=3000` and internal `MockUpstreamServer` on `127.0.0.1:3001`):
   ```bash
   npm start
   ```

## Authentication & Token Minting
Generate local HS256 JWTs for different scopes (`support`, `write`, `finance`, `all`):
```bash
SUPPORT_JWT=$(npm run --silent token:mint -- --role support)
WRITE_JWT=$(npm run --silent token:mint -- --role write)
FINANCE_JWT=$(npm run --silent token:mint -- --role finance)
```

## Example `curl` Workflows
```bash
# 1. Public health check
curl -s http://127.0.0.1:3000/health | jq .

# 2. Customer aggregation (account alias ACC-77 -> ACC-007, ARR redacted without finance:read)
curl -s -H "Authorization: Bearer $SUPPORT_JWT" \
  http://127.0.0.1:3000/v1/customers/ACC-77 | jq .

# 3. Customer aggregation with finance:read + simulated Snowflake timeout degradation
curl -s -H "Authorization: Bearer $FINANCE_JWT" \
  -H "X-Fault-Inject: snowflake=timeout" \
  http://127.0.0.1:3000/v1/customers/ACC-007 | jq .

# 4. Filter & cursor-paginate open cases >48h old
curl -s -H "Authorization: Bearer $SUPPORT_JWT" \
  "http://127.0.0.1:3000/v1/cases?status=open&minAgeHours=48&sort=priority:desc&limit=10" | jq .

# 5. Idempotently add a case comment (replay with same Idempotency-Key returns Idempotent-Replayed: true)
curl -i -X POST http://127.0.0.1:3000/v1/cases/CS-10231/comments \
  -H "Authorization: Bearer $WRITE_JWT" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-key-1001" \
  -d '{"body":"Investigating snapshot latency"}'

# 6. Escalate case with strong ETag optimistic lock (If-Match)
curl -i -X POST http://127.0.0.1:3000/v1/cases/CS-10232/escalate \
  -H "Authorization: Bearer $WRITE_JWT" \
  -H "Content-Type: application/json" \
  -H "If-Match: \"v1\"" \
  -d '{"reason":"Open P2 case exceeding 48h SLA","targetPriority":"P1"}'
```

## Postman Collection
Import both files into Postman:
- Collection: [zeal-platform.postman_collection.json](./postman/zeal-platform.postman_collection.json)
- Environment: [zeal-local.postman_environment.json](./postman/zeal-local.postman_environment.json) (includes pre-minted dev tokens matching `.env.example`'s `JWT_SECRET`).

## MCP Server & Copilot Demo
With the REST API running (`npm start`), run the zero-key deterministic MCP workflow:
```bash
npm run demo:mcp -- --mode=deterministic --auto-confirm
```
Or run with a free tool-capable OpenRouter model (`OPENROUTER_MODEL=baidu/ernie-5.5-flash-preview:free`, auto-falling back to `OPENROUTER_FALLBACK_MODEL=meta-llama/llama-3.3-70b-instruct:free`):
```bash
OPENROUTER_API_KEY="your-key" npm run demo:mcp -- --mode=openrouter
```
To launch only the MCP `stdio` server (for Claude Desktop / MCP Inspector / custom clients):
```bash
MCP_USER_JWT="$WRITE_JWT" npm run mcp:start
```
See [mcp/demo/transcript.md](./mcp/demo/transcript.md) for a recorded execution transcript and documented guardrail fix.

## Project Deliverables & Documentation
- API Contract: [openapi.yaml](./openapi.yaml)
- Design Decisions & Trade-offs: [DECISIONS.md](./DECISIONS.md)
- Security & Threat Controls: [SECURITY.md](./SECURITY.md)
- Testing & Agent Evals: [TESTEVALS.md](./TESTEVALS.md)
- AI Usage Disclosure: [AI_USAGE.md](./AI_USAGE.md)
- Design Specification: [customer-entitlement-support-api.md](./docs/designs/customer-entitlement-support-api.md)

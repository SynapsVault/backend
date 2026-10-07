<div align="center">
  <h1>⬡ SynapsVault — Backend</h1>
  <p><strong>Express API server for the SynapsVault knowledge vault marketplace</strong></p>
  <p>
    <a href="https://github.com/SynapsVault/backend/actions"><img src="https://github.com/SynapsVault/backend/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <img src="https://img.shields.io/badge/Node.js-24-green" alt="Node.js">
    <img src="https://img.shields.io/badge/TypeScript-6-blue" alt="TypeScript">
    <img src="https://img.shields.io/badge/Stellar-x402-7D00FF" alt="Stellar">
    <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  </p>
</div>

---

## Overview

SynapsVault-backend is the Express.js API powering the SynapsVault marketplace. It handles:

- **Publisher registration** — API key issuance, wallet linking
- **Resource publishing** — file upload to Supabase, link registration
- **x402 payment verification** — Stellar USDC micropayment validation
- **On-chain registration** — Soroban vault-registry contract calls
- **Catalog serving** — searched, filtered, paginated resource listings
- **Admin panel** — protected stats, force-delist, payment audit
- **Webhook delivery** — HMAC-signed event fanout to publisher endpoints

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │           SynapsVault Backend             │
                    │                                         │
  Frontend ──────►  │  Express app                            │
  (React/Vite)      │  ├── /resources    CRUD + catalog       │
                    │  ├── /verify-content  AI originality    │
                    │  ├── /publishers   profile + keys       │
                    │  ├── /registry     on-chain status      │
                    │  ├── /payments     receipts + history   │
                    │  ├── /admin        protected stats      │
                    │  ├── /health       k8s probes           │
                    │  └── /docs         OpenAPI + Swagger    │
                    │                                         │
                    │  Middleware stack                        │
                    │  ├── CORS + Security headers            │
                    │  ├── Rate limiting (IP + wallet)        │
                    │  ├── API key auth                       │
                    │  ├── Request signature auth             │
                    │  ├── Audit log (all mutations)          │
                    │  ├── Circuit breaker (Stellar RPC)      │
                    │  └── Request tracing (OpenTelemetry)    │
                    └──────────────┬──────────────────────────┘
                                   │
               ┌───────────────────┼───────────────────┐
               ▼                   ▼                   ▼
        Supabase DB         Stellar Horizon      Soroban Contracts
        (PostgreSQL)        (x402 + USDC)       (vault-registry
        resources           payment verify       access-lease
        payments            tx submission        subscription)
        publishers
```

## Quick start

Requires **Node.js 24** (npm 11) and PostgreSQL 16.

```bash
git clone https://github.com/SynapsVault/backend SynapsVault-backend
cd SynapsVault-backend
npm ci

cp .env.example .env
# Fill in the required values (marked "required" in .env.example). The server
# validates config on boot and exits listing anything missing.

npm run db:migrate   # apply drizzle migrations
npm run dev          # dev server with hot reload (default port 4021)

npm run typecheck
npm test
npm run build && npm start
```

## Docker

```bash
# Single container (listens on 3000; run migrations first)
docker build -t synapsvault-backend .
docker run --env-file .env -p 3000:3000 synapsvault-backend

# Full stack (API + Postgres), using values from .env
docker compose up
```

## API reference

The OpenAPI 3 spec is served at `/openapi.json`, with Swagger UI at `/docs`.

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/health`, `/health/ready` | — | Liveness / readiness (DB + Soroban RPC) |
| `GET` | `/metrics` | Bearer `METRICS_TOKEN` | Prometheus metrics |
| `GET` | `/resources` | — | Catalog: search, price/type/status filters, sort, pagination |
| `POST` | `/resources` | API key | Publish a file (multipart) or link resource |
| `GET` | `/resources/:id/meta` | — | Public preview |
| `GET` | `/resources/:id` | x402 | Pay and access the resource |
| `DELETE` | `/resources/:id` | API key | Delist own resource |
| `GET` | `/resources/:id/register/prepare` | API key | Unsigned on-chain register tx |
| `POST` | `/resources/:id/register` | API key | Submit signed register tx |
| `POST` | `/resources/:id/price[/prepare]` | API key | Update on-chain price |
| `POST` | `/resources/:id/ownership[/prepare]` | API key | Transfer on-chain ownership |
| `POST` | `/verify-content` | x402 | AI originality check |
| `GET` | `/agent/status` | — | Verification agent stats |
| `POST` | `/publishers` | — | Register; returns the API key once |
| `GET` | `/publishers/me[/resources\|/analytics]` | API key | Profile, resources, earnings |
| `GET` `PATCH` | `/publishers/me/rate-limit` | API key | View / override own rate limit |
| `GET` `PATCH` | `/publishers/me/webhooks` | API key | Webhook URL, secret, events |
| `POST` | `/publishers/me/webhooks/test` | API key | Send a signed test event |
| `GET` | `/publishers/leaderboard` | — | Creator leaderboard |
| `GET` | `/payments/:id/receipt` | — | Payment receipt |
| `GET` | `/buyers/:address/payments` | — | Buyer purchase history |
| `GET` | `/registry/status` | — | On-chain registry stats |
| `GET` | `/admin/stats`, `/admin/audit` | Admin key | Platform metrics, payment audit |
| `POST` | `/admin/delist/:id` | Admin key | Force delist |

### Errors

Every error response has the same shape:

```json
{ "error": "Resource not found", "code": "NOT_FOUND", "requestId": "…" }
```

`code` is one of `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
`CONFLICT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `INTERNAL_ERROR`,
`UPSTREAM_ERROR`, `SERVICE_UNAVAILABLE` or `GATEWAY_TIMEOUT`. Validation errors
add field-level `details`. The `requestId` matches the `x-request-id` header.

### Webhooks

Publishers configure one endpoint with `PATCH /publishers/me/webhooks`
(`webhookUrl`, `webhookSecret`, `webhookEvents`, `webhookEnabled`). Events:
`resource.purchased`, `payment.received`, `resource.listed`, `resource.delisted`.
Deliveries are `POST { event, timestamp, data }`. When a secret is set,
`X-SynapsVault-Signature` holds the hex HMAC-SHA256 of the raw body:

```js
const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
```

Failures are retried with exponential backoff (`WEBHOOK_MAX_ATTEMPTS`).
Private and loopback URLs are rejected.

## Environment variables

See [`.env.example`](./.env.example) for the full list and descriptions.

## CI

Every push and PR to `main`/`dev` runs [`ci.yml`](.github/workflows/ci.yml):

1. **Typecheck & Test**: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`
2. **Docker build & smoke test**: builds the image, applies migrations to a
   Postgres service, boots the container and checks key endpoints.

[`catalog-seed.yml`](.github/workflows/catalog-seed.yml) runs weekly (or on
demand) to seed a testnet catalog and verify it end to end.

## Repo siblings

| Repo | Description |
|---|---|
| [SynapsVault-frontend](https://github.com/SynapsVault/frontend) | React UI |
| [SynapsVault-contracts](https://github.com/SynapsVault/contracts) | Soroban contracts |

## License

MIT © 2025 Busiii-adetiba
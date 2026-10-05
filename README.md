<div align="center">
  <h1>⬡ SynapsVault — Backend</h1>
  <p><strong>Express API server for the SynapsVault knowledge vault marketplace</strong></p>
  <p>
    <a href="https://github.com/SynapsVault/backend/actions"><img src="https://github.com/SynapsVault/backend/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <img src="https://img.shields.io/badge/Node.js-20-green" alt="Node.js">
    <img src="https://img.shields.io/badge/TypeScript-5-blue" alt="TypeScript">
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
                    │  ├── /verify       x402 payment check   │
                    │  ├── /publishers   profile + keys       │
                    │  ├── /registry     on-chain status      │
                    │  ├── /payments     purchase history     │
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

```bash
git clone https://github.com/SynapsVault/backend SynapsVault-backend
cd SynapsVault-backend
npm install

cp .env.example .env
# Fill in DATABASE_URL, SUPABASE_*, STELLAR_*, ADMIN_API_KEY

# Run database migrations
npm run db:migrate

# Start dev server (hot reload)
npm run dev

# Run tests
npm run test

# Production build
npm run build && npm start
```

## Docker (recommended for production)

```bash
# Single container
docker build -t synapsvault-backend .
docker run --env-file .env -p 3000:3000 synapsvault-backend

# Full stack (API + Postgres)
docker compose up
```

## API reference

Full OpenAPI spec at `/docs` when running.

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | — | Liveness + readiness |
| `GET` | `/metrics` | — | Prometheus metrics |
| `GET` | `/resources` | — | Browse catalog |
| `POST` | `/resources` | API key | Publish resource |
| `GET` | `/resources/:id` | x402 | Download/access (paywall) |
| `PATCH` | `/resources/:id/price` | API key | Update price |
| `POST` | `/resources/:id/register` | API key | Register on-chain |
| `POST` | `/resources/:id/delist` | API key | Delist resource |
| `GET` | `/publishers/:id` | — | Publisher profile |
| `POST` | `/verify` | — | Verify x402 payment |
| `GET` | `/payments` | — | Purchase history |
| `GET` | `/registry/status` | — | On-chain registry stats |
| `GET` | `/admin/stats` | Admin key | Platform metrics |
| `POST` | `/admin/delist/:id` | Admin key | Force delist |
| `GET` | `/admin/audit` | Admin key | Payment audit log |
| `GET` | `/docs` | — | Swagger UI |

## Environment variables

See [`.env.example`](./.env.example) for the full list and descriptions.

## Workflow / CI

```
Push to feat/* ──► CI (typecheck + test + docker build)
                         │
Merge to dev   ──► CI + staging deploy
                         │
Merge to main  ──► CI + Docker push to GHCR + production deploy
```

Configure these GitHub secrets for CD to work:
- `DEPLOY_WEBHOOK_URL` — your Railway/Render deploy hook URL

## Repo siblings

| Repo | Description |
|---|---|
| [SynapsVault-frontend](https://github.com/SynapsVault/frontend) | React UI |
| [SynapsVault-contracts](https://github.com/SynapsVault/contracts) | Soroban contracts |

## License

MIT © 2025 bolu26
# Contributing to SynapsVault Backend

## Setup

```bash
pnpm install
cp .env.example .env
docker compose up postgres -d   # local postgres
pnpm drizzle-kit migrate
pnpm dev
```

## Branch strategy

| Branch | Purpose |
|--------|---------|
| `main` | Production |
| `dev`  | Staging / integration |
| `feat/*` | Feature branches — PR to dev |
| `fix/*`  | Bug fixes — PR to dev |

## Testing

```bash
pnpm test              # all tests
pnpm test --watch      # watch mode
pnpm test src/routes   # specific folder
```

## Adding a new route

1. Create `src/routes/myroute.ts` (Router pattern — see existing routes)
2. Register in `src/app.ts`: `app.use(myRouter)`
3. Add OpenAPI annotation in `src/openapi.ts`
4. Write tests in `src/routes/myroute.test.ts`

## Commit format (Conventional Commits)

```
feat: add admin webhook delivery endpoint
fix: race condition in idempotency store
test: add circuit breaker unit tests
chore: upgrade drizzle-orm to 0.32
```

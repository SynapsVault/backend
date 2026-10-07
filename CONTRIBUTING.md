# Contributing to SynapsVault Backend

Welcome! We're building a Stellar-powered marketplace for digital resources. This guide covers local development, testing, and code standards.

## Local Development

### Prerequisites
- Node.js 24+ (npm 11)
- Docker & Docker Compose (for PostgreSQL)

### Setup

```bash
# Install dependencies
npm ci

# Copy environment variables
cp .env.example .env

# Start PostgreSQL (detached)
docker compose up postgres -d

# Run migrations
npm run db:migrate

# Start dev server (hot reload)
npm run dev
```

Dev server runs at `http://localhost:3000` with TypeScript hot-reload.

### Docker Workflow

```bash
# Build + run full stack (API + DB)
docker compose up

# Rebuild image
npm run docker:build

# Stop containers
docker compose down

# View logs
npm run docker:logs
```

## Branch Strategy

| Branch | Purpose | Target |
|--------|---------|--------|
| `main` | Production-ready code | Deployed to production |
| `dev` | Staging/integration | Pre-release testing |
| `feat/*` | New features | PR to `dev` |
| `fix/*` | Bug fixes | PR to `dev` |
| `chore/*` | Maintenance | PR to `dev` |

## Development Workflow

1. Create feature branch: `git checkout -b feat/my-feature`
2. Make changes and test locally
3. Run type checking: `npm run typecheck`
4. Run tests: `npm run test`
5. Commit with conventional format (see below)
6. Push and open PR to `dev`

## Testing

```bash
npm run test              # Run all tests once
npm run test:watch       # Watch mode (rerun on changes)
npm run test src/routes  # Test specific folder
```

All critical paths must have tests. Aim for >80% coverage on routes.

## Adding a New Route

1. **Create route file**: `src/routes/my-endpoint.ts`
   ```typescript
   import { Router } from 'express';
   const router = Router();
   
   router.post('/my-endpoint', async (req, res) => {
     // Implementation
   });
   
   export default router;
   ```

2. **Register in app**: Edit `src/app.ts`
   ```typescript
   import myRouter from './routes/my-endpoint';
   app.use('/api', myRouter);
   ```

3. **Add tests**: Create `src/routes/my-endpoint.test.ts`

4. **Document**: Add OpenAPI annotation if public endpoint

## Code Standards

- **TypeScript**: Strict mode enabled, no `any` without comment
- **Async/await**: Prefer over callbacks
- **Error handling**: Use try/catch in handlers, proper HTTP status codes
- **Database**: Use Drizzle ORM, migrations for schema changes
- **Environment**: Load via `.env` (never hardcode secrets)

## Commit Format (Conventional Commits)

```
feat(routes): add payment webhook endpoint
fix(db): handle concurrent subscription renewals
test(auth): add signature verification tests
docs: improve deployment guide
chore: upgrade express to 5.0
```

**Types**: feat, fix, test, docs, chore, refactor, perf

## Database Changes

```bash
# Make schema changes in src/db/schema.ts
npm run db:generate   # Create migration
npm run db:migrate    # Apply migration
```

## Code Review Checklist

- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Tests pass (`npm run test`)
- [ ] No console.log in production code
- [ ] Database migrations included
- [ ] Error handling for edge cases
- [ ] Follows conventional commit format

## Questions?

- Open a GitHub issue
- Check existing PRs for similar work
- Ask in Stellar Dev Discord #synapsvault

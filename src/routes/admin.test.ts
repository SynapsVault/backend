import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// mockConfig must be hoisted so the vi.mock factory can reference it.
const mockConfig = vi.hoisted(() => ({
  ADMIN_API_KEY: undefined as string | undefined,
  NODE_ENV: 'test' as const,
}));

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

vi.mock('../db/client.js', () => {
  const select = vi.fn();
  const from = vi.fn();
  const where = vi.fn();
  const orderBy = vi.fn();
  const limit = vi.fn();
  const offset = vi.fn();
  const chain: any = {};
  chain.select = select;
  chain.from = from;
  chain.where = where;
  chain.orderBy = orderBy;
  chain.limit = limit;
  chain.offset = offset;
  select.mockReturnValue(chain);
  from.mockReturnValue(chain);
  where.mockReturnValue(chain);
  orderBy.mockReturnValue(chain);
  limit.mockReturnValue(chain);
  offset.mockReturnValue(chain);
  return {
    db: {
      select,
      from,
      where,
      orderBy,
      limit,
      offset,
    },
  };
});

vi.mock('../services/resourceService.js', () => ({
  adminDelistResource: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  rootLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { default as adminRouter } from './admin.js';
import * as dbClient from '../db/client.js';
import * as resourceService from '../services/resourceService.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  // Real app mounts adminRouter directly (no prefix) — routes include /admin/* prefix.
  app.use(adminRouter);
  // Mirror src/middleware/errorHandler.ts: map AppError to status code.
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    res.status(status).json({ error: err?.message ?? 'Internal Server Error' });
  });
  return app;
}

describe('admin routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.ADMIN_API_KEY = undefined;
  });

  describe('auth check', () => {
    it('returns 401 when X-Admin-Key header is missing', async () => {
      mockConfig.ADMIN_API_KEY = 'secret-key';
      const res = await request(buildApp()).get('/admin/stats');
      expect(res.status).toBe(401);
    });

    it('returns 401 when X-Admin-Key is wrong', async () => {
      mockConfig.ADMIN_API_KEY = 'secret-key';
      const res = await request(buildApp())
        .get('/admin/stats')
        .set('X-Admin-Key', 'wrong-key');
      expect(res.status).toBe(401);
    });

    it('returns 401 when ADMIN_API_KEY is unset', async () => {
      mockConfig.ADMIN_API_KEY = undefined;
      const res = await request(buildApp())
        .get('/admin/stats')
        .set('X-Admin-Key', 'anything');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /admin/stats', () => {
    it('returns counts from the db plus uptime and timestamp', async () => {
      mockConfig.ADMIN_API_KEY = 'secret-key';

      const db = dbClient.db as any;
      // Each select chain resolves to a count row.
      db.select.mockImplementation(() => {
        const chain: any = {};
        chain.from = vi.fn().mockResolvedValue([{ count: 7 }]);
        return chain;
      });

      const res = await request(buildApp())
        .get('/admin/stats')
        .set('X-Admin-Key', 'secret-key');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('uptime');
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body).toHaveProperty('timestamp');
      expect(typeof res.body.timestamp).toBe('string');
    });
  });

  describe('POST /admin/delist/:id', () => {
    it('returns success when adminDelistResource resolves', async () => {
      mockConfig.ADMIN_API_KEY = 'secret-key';
      (resourceService.adminDelistResource as any).mockResolvedValue({
        id: 'res-1',
        delisted: true,
      });

      const res = await request(buildApp())
        .post('/admin/delist/res-1')
        .set('X-Admin-Key', 'secret-key');

      expect(res.status).toBe(200);
      expect(resourceService.adminDelistResource).toHaveBeenCalledWith('res-1');
    });

    it('returns 404 when adminDelistResource resolves null', async () => {
      mockConfig.ADMIN_API_KEY = 'secret-key';
      (resourceService.adminDelistResource as any).mockResolvedValue(null);

      const res = await request(buildApp())
        .post('/admin/delist/missing')
        .set('X-Admin-Key', 'secret-key');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /admin/audit', () => {
    it('returns paginated entries', async () => {
      mockConfig.ADMIN_API_KEY = 'secret-key';

      const db = dbClient.db as any;
      const entries = [
        { id: 'a1', action: 'delist', createdAt: new Date().toISOString() },
        { id: 'a2', action: 'delist', createdAt: new Date().toISOString() },
      ];
      const offsetMock = vi.fn().mockResolvedValue(entries);
      const limitMock = vi.fn().mockReturnValue({ offset: offsetMock });
      const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
      const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      db.select.mockReturnValue({ from: fromMock });

      const res = await request(buildApp())
        .get('/admin/audit')
        .set('X-Admin-Key', 'secret-key');

      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual(entries);
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('limit');
    });

    it('clamps limit to [1,200] and page to >=1', async () => {
      mockConfig.ADMIN_API_KEY = 'secret-key';

      const db = dbClient.db as any;

      function setupChain() {
        const offsetMock = vi.fn().mockResolvedValue([]);
        const limitMock = vi.fn().mockReturnValue({ offset: offsetMock });
        const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
        const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
        const fromMock = vi.fn().mockReturnValue({ where: whereMock });
        db.select.mockReturnValue({ from: fromMock });
        return { limitMock, offsetMock };
      }

      const app = buildApp();

      // limit too high, page too low (page 0 → clamped to 1, offset = 0)
      const chain1 = setupChain();
      await request(app)
        .get('/admin/audit?limit=9999&page=0')
        .set('X-Admin-Key', 'secret-key');
      expect(chain1.limitMock).toHaveBeenLastCalledWith(200);
      expect(chain1.offsetMock).toHaveBeenLastCalledWith(0);

      // explicit low limit (1), page 3 → offset = 2
      const chain2 = setupChain();
      await request(app)
        .get('/admin/audit?limit=1&page=3')
        .set('X-Admin-Key', 'secret-key');
      expect(chain2.limitMock).toHaveBeenLastCalledWith(1);
      expect(chain2.offsetMock).toHaveBeenLastCalledWith(2);
    });
  });
});

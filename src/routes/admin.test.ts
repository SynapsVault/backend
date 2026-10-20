import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db/client.js', () => {
  return {
    db: {
      select: vi.fn(),
    },
  };
});

vi.mock('../services/resourceService.js', () => ({
  adminDelistResource: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as dbClient from '../db/client.js';
import * as resourceService from '../services/resourceService.js';

const ORIGINAL_ENV = { ...process.env };

// Build the Express app once; admin.ts reads process.env at request time,
// not at import time, so we don't need to re-import between tests.
let app: ReturnType<typeof express>;

async function getApp() {
  if (!app) {
    const { default: adminRouter } = await import('./admin.js');
    app = express();
    app.use(express.json());
    // Mount without a prefix — the router registers /admin/stats, etc. itself,
    // matching how app.ts does it with app.use(adminRouter).
    app.use(adminRouter);
    // Map AppError codes to HTTP status codes (mirror errorHandler.ts).
    app.use((err: any, _req: any, res: any, _next: any) => {
      const codes: Record<string, number> = {
        UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION_ERROR: 400,
      };
      const status = codes[err?.code] ?? (typeof err?.status === 'number' ? err.status : 500);
      res.status(status).json({ error: err?.message ?? 'Internal Server Error' });
    });
  }
  return app;
}

describe('admin routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('auth check', () => {
    it('returns 401 when X-Admin-Key header is missing', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';
      const res = await request(await getApp()).get('/admin/stats');
      expect(res.status).toBe(401);
    });

    it('returns 401 when X-Admin-Key is wrong', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';
      const res = await request(await getApp())
        .get('/admin/stats')
        .set('X-Admin-Key', 'wrong-key');
      expect(res.status).toBe(401);
    });

    it('returns 401 when ADMIN_API_KEY is unset', async () => {
      delete process.env.ADMIN_API_KEY;
      const res = await request(await getApp())
        .get('/admin/stats')
        .set('X-Admin-Key', 'anything');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /admin/stats', () => {
    it('returns counts from the db plus uptime and timestamp', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';

      // The stats route calls db.select({count}).from(table) three times in parallel.
      // Each Promise.all element resolves to [[{count: N}]].
      (dbClient.db.select as any).mockImplementation(() => ({
        from: vi.fn().mockResolvedValue([{ count: 7 }]),
      }));

      const res = await request(await getApp())
        .get('/admin/stats')
        .set('X-Admin-Key', 'secret-key');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('uptime');
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body).toHaveProperty('timestamp');
      expect(typeof res.body.timestamp).toBe('string');
      // The route returns top-level resource / publisher / payment counts.
      expect(res.body.resources).toBeDefined();
      expect(res.body.publishers).toBeDefined();
      expect(res.body.payments).toBeDefined();
    });
  });

  describe('POST /admin/delist/:id', () => {
    it('returns success when adminDelistResource resolves', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';
      (resourceService.adminDelistResource as any).mockResolvedValue({
        id: 'res-1',
      });

      const res = await request(await getApp())
        .post('/admin/delist/res-1')
        .set('X-Admin-Key', 'secret-key');

      expect(res.status).toBe(200);
      expect(resourceService.adminDelistResource).toHaveBeenCalledWith(
        'res-1',
        expect.objectContaining({ actor: expect.stringMatching(/^admin:/) }),
      );
    });

    it('passes reason from request body to adminDelistResource', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';
      (resourceService.adminDelistResource as any).mockResolvedValue({ id: 'res-2' });

      await request(await getApp())
        .post('/admin/delist/res-2')
        .set('X-Admin-Key', 'secret-key')
        .send({ reason: 'copyright violation' });

      expect(resourceService.adminDelistResource).toHaveBeenCalledWith(
        'res-2',
        expect.objectContaining({ reason: 'copyright violation' }),
      );
    });

    it('returns 404 when adminDelistResource resolves null', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';
      (resourceService.adminDelistResource as any).mockResolvedValue(null);

      const res = await request(await getApp())
        .post('/admin/delist/missing')
        .set('X-Admin-Key', 'secret-key');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /admin/audit', () => {
    it('returns paginated entries', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';

      const entries = [
        { id: 'a1', resourceId: 'r1', payer: 'G1', amount: '1.00', paidAt: new Date().toISOString() },
        { id: 'a2', resourceId: 'r2', payer: 'G2', amount: '2.00', paidAt: new Date().toISOString() },
      ];
      // The audit query: db.select({...}).from(payments).where(...).orderBy(...).limit(...).offset(...)
      const offsetMock = vi.fn().mockResolvedValue(entries);
      const limitMock = vi.fn().mockReturnValue({ offset: offsetMock });
      const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
      const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      (dbClient.db.select as any).mockReturnValue({ from: fromMock });

      const res = await request(await getApp())
        .get('/admin/audit')
        .set('X-Admin-Key', 'secret-key');

      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual(entries);
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('limit');
    });

    it('clamps limit to [1,200] and page to >=1', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';

      const offsetMock = vi.fn().mockResolvedValue([]);
      const limitMock = vi.fn().mockReturnValue({ offset: offsetMock });
      const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
      const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      (dbClient.db.select as any).mockReturnValue({ from: fromMock });

      // limit too high, page too low (page 0 becomes 1, offset 0)
      await request(await getApp())
        .get('/admin/audit?limit=9999&page=0')
        .set('X-Admin-Key', 'secret-key');

      expect(limitMock).toHaveBeenLastCalledWith(200);
      expect(offsetMock).toHaveBeenLastCalledWith(0);

      // limit too low (0 is falsy so it falls back to the default of 50), page valid (page 3, offset = (3-1)*50 = 100)
      await request(await getApp())
        .get('/admin/audit?limit=0&page=3')
        .set('X-Admin-Key', 'secret-key');

      // limit=0 is falsy → defaults to 50 (the || 50 fallback in admin.ts)
      expect(limitMock).toHaveBeenLastCalledWith(50);
      expect(offsetMock).toHaveBeenLastCalledWith(100);
    });
  });
});

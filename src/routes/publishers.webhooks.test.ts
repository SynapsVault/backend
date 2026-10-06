import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock auth middleware
const mockAuth = vi.fn((req: any, _res: any, next: any) => {
  req.user = { id: 'user-1', role: 'publisher' };
  next();
});

const mockRequireAuth = vi.fn((req: any, res: any, next: any) => {
  if (!req.headers.authorization) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = { id: 'user-1', role: 'publisher' };
  next();
});

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: any, res: any, next: any) => mockRequireAuth(req, res, next),
  auth: (req: any, res: any, next: any) => mockAuth(req, res, next),
}));

// Mock rate limit service
const mockGetRateLimit = vi.fn();
const mockUpdateRateLimit = vi.fn();

vi.mock('../services/rateLimitService', () => ({
  getRateLimit: (...args: any[]) => mockGetRateLimit(...args),
  updateRateLimit: (...args: any[]) => mockUpdateRateLimit(...args),
}));

// Mock webhook service
const mockListWebhooks = vi.fn();
const mockCreateWebhook = vi.fn();
const mockUpdateWebhook = vi.fn();
const mockDeleteWebhook = vi.fn();

vi.mock('../services/webhookService', () => ({
  listWebhooks: (...args: any[]) => mockListWebhooks(...args),
  createWebhook: (...args: any[]) => mockCreateWebhook(...args),
  updateWebhook: (...args: any[]) => mockUpdateWebhook(...args),
  deleteWebhook: (...args: any[]) => mockDeleteWebhook(...args),
}));

import publishersRouter from './publishers';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/publishers', publishersRouter);
  return app;
}

describe('publisher rate-limit and webhook routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
    vi.clearAllMocks();
  });

  describe('GET /publishers/:id/rate-limit', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/publishers/pub-1/rate-limit');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
    });

    it('returns the rate limit for the publisher', async () => {
      mockGetRateLimit.mockResolvedValue({
        publisherId: 'pub-1',
        requestsPerMinute: 120,
        burst: 20,
      });

      const res = await request(app)
        .get('/publishers/pub-1/rate-limit')
        .set('Authorization', 'Bearer token');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        publisherId: 'pub-1',
        requestsPerMinute: 120,
        burst: 20,
      });
      expect(mockGetRateLimit).toHaveBeenCalledWith('pub-1');
    });

    it('returns 404 when the publisher does not exist', async () => {
      mockGetRateLimit.mockResolvedValue(null);

      const res = await request(app)
        .get('/publishers/missing/rate-limit')
        .set('Authorization', 'Bearer token');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Publisher not found' });
    });
  });

  describe('PUT /publishers/:id/rate-limit', () => {
    it('requires authentication', async () => {
      const res = await request(app)
        .put('/publishers/pub-1/rate-limit')
        .send({ requestsPerMinute: 60 });

      expect(res.status).toBe(401);
    });

    it('rejects invalid payloads', async () => {
      const res = await request(app)
        .put('/publishers/pub-1/rate-limit')
        .set('Authorization', 'Bearer token')
        .send({ requestsPerMinute: -5 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(mockUpdateRateLimit).not.toHaveBeenCalled();
    });

    it('rejects non-numeric values', async () => {
      const res = await request(app)
        .put('/publishers/pub-1/rate-limit')
        .set('Authorization', 'Bearer token')
        .send({ requestsPerMinute: 'fast' });

      expect(res.status).toBe(400);
      expect(mockUpdateRateLimit).not.toHaveBeenCalled();
    });

    it('updates the rate limit', async () => {
      mockUpdateRateLimit.mockResolvedValue({
        publisherId: 'pub-1',
        requestsPerMinute: 60,
        burst: 10,
      });

      const res = await request(app)
        .put('/publishers/pub-1/rate-limit')
        .set('Authorization', 'Bearer token')
        .send({ requestsPerMinute: 60, burst: 10 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        publisherId: 'pub-1',
        requestsPerMinute: 60,
        burst: 10,
      });
      expect(mockUpdateRateLimit).toHaveBeenCalledWith('pub-1', {
        requestsPerMinute: 60,
        burst: 10,
      });
    });
  });

  describe('GET /publishers/:id/webhooks', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/publishers/pub-1/webhooks');
      expect(res.status).toBe(401);
    });

    it('masks webhook secrets in the response', async () => {
      mockListWebhooks.mockResolvedValue([
        {
          id: 'wh-1',
          publisherId: 'pub-1',
          url: 'https://example.com/hook',
          secret: 'super-secret-value',
          events: ['publish'],
          active: true,
        },
      ]);

      const res = await request(app)
        .get('/publishers/pub-1/webhooks')
        .set('Authorization', 'Bearer token');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].secret).not.toBe('super-secret-value');
      expect(res.body[0].secret).toMatch(/\*+/);
      expect(res.body[0].url).toBe('https://example.com/hook');
      expect(res.body[0].id).toBe('wh-1');
    });

    it('returns an empty list when there are no webhooks', async () => {
      mockListWebhooks.mockResolvedValue([]);

      const res = await request(app)
        .get('/publishers/pub-1/webhooks')
        .set('Authorization', 'Bearer token');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('POST /publishers/:id/webhooks', () => {
    it('requires authentication', async () => {
      const res = await request(app)
        .post('/publishers/pub-1/webhooks')
        .send({ url: 'https://example.com/hook', events: ['publish'] });

      expect(res.status).toBe(401);
    });

    it('rejects missing url', async () => {
      const res = await request(app)
        .post('/publishers/pub-1/webhooks')
        .set('Authorization', 'Bearer token')
        .send({ events: ['publish'] });

      expect(res.status).toBe(400);
      expect(mockCreateWebhook).not.toHaveBeenCalled();
    });

    it('rejects invalid url', async () => {
      const res = await request(app)
        .post('/publishers/pub-1/webhooks')
        .set('Authorization', 'Bearer token')
        .send({ url: 'not-a-url', events: ['publish'] });

      expect(res.status).toBe(400);
      expect(mockCreateWebhook).not.toHaveBeenCalled();
    });

    it('rejects empty events array', async () => {
      const res = await request(app)
        .post('/publishers/pub-1/webhooks')
        .set('Authorization', 'Bearer token')
        .send({ url: 'https://example.com/hook', events: [] });

      expect(res.status).toBe(400);
      expect(mockCreateWebhook).not.toHaveBeenCalled();
    });

    it('creates a webhook and masks the secret', async () => {
      mockCreateWebhook.mockResolvedValue({
        id: 'wh-2',
        publisherId: 'pub-1',
        url: 'https://example.com/hook',
        secret: 'generated-secret',
        events: ['publish'],
        active: true,
      });

      const res = await request(app)
        .post('/publishers/pub-1/webhooks')
        .set('Authorization', 'Bearer token')
        .send({ url: 'https://example.com/hook', events: ['publish'] });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('wh-2');
      expect(res.body.secret).not.toBe('generated-secret');
      expect(res.body.secret).toMatch(/\*+/);
      expect(mockCreateWebhook).toHaveBeenCalledWith('pub-1', {
        url: 'https://example.com/hook',
        events: ['publish'],
      });
    });
  });

  describe('PATCH /publishers/:id/webhooks/:webhookId', () => {
    it('requires authentication', async () => {
      const res = await request(app)
        .patch('/publishers/pub-1/webhooks/wh-1')
        .send({ active: false });

      expect(res.status).toBe(401);
    });

    it('rejects invalid url updates', async () => {
      const res = await request(app)
        .patch('/publishers/pub-1/webhooks/wh-1')
        .set('Authorization', 'Bearer token')
        .send({ url: 'bad-url' });

      expect(res.status).toBe(400);
      expect(mockUpdateWebhook).not.toHaveBeenCalled();
    });

    it('returns 404 when the webhook does not exist', async () => {
      mockUpdateWebhook.mockResolvedValue(null);

      const res = await request(app)
        .patch('/publishers/pub-1/webhooks/missing')
        .set('Authorization', 'Bearer token')
        .send({ active: false });

      expect(res.status).toBe(404);
    });

    it('updates a webhook and masks the secret', async () => {
      mockUpdateWebhook.mockResolvedValue({
        id: 'wh-1',
        publisherId: 'pub-1',
        url: 'https://example.com/hook',
        secret: 'existing-secret',
        events: ['publish'],
        active: false,
      });

      const res = await request(app)
        .patch('/publishers/pub-1/webhooks/wh-1')
        .set('Authorization', 'Bearer token')
        .send({ active: false });

      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
      expect(res.body.secret).not.toBe('existing-secret');
      expect(res.body.secret).toMatch(/\*+/);
    });
  });

  describe('DELETE /publishers/:id/webhooks/:webhookId', () => {
    it('requires authentication', async () => {
      const res = await request(app).delete('/publishers/pub-1/webhooks/wh-1');
      expect(res.status).toBe(401);
    });

    it('returns 404 when the webhook does not exist', async () => {
      mockDeleteWebhook.mockResolvedValue(false);

      const res = await request(app)
        .delete('/publishers/pub-1/webhooks/missing')
        .set('Authorization', 'Bearer token');

      expect(res.status).toBe(404);
    });

    it('deletes a webhook', async () => {
      mockDeleteWebhook.mockResolvedValue(true);

      const res = await request(app)
        .delete('/publishers/pub-1/webhooks/wh-1')
        .set('Authorization', 'Bearer token');

      expect(res.status).toBe(204);
      expect(mockDeleteWebhook).toHaveBeenCalledWith('pub-1', 'wh-1');
    });
  });
});
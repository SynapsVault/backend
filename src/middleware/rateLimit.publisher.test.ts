import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createPublisherRateLimiter } from './rateLimit.publisher';

interface MockStore {
  incr: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  ttl: ReturnType<typeof vi.fn>;
}

function createMockStore(): MockStore {
  return {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  };
}

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response & {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
} {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  };
}

describe('createPublisherRateLimiter', () => {
  let store: MockStore;
  let next: NextFunction;

  beforeEach(() => {
    store = createMockStore();
    next = vi.fn();
  });

  it('keys limits per publisher', async () => {
    store.incr.mockImplementation(async (key: string) => {
      if (key.includes('publisher:alpha')) return 1;
      if (key.includes('publisher:beta')) return 1;
      return 1;
    });
    store.expire.mockResolvedValue(1);
    store.ttl.mockResolvedValue(60);

    const limiter = createPublisherRateLimiter({
      store: store as never,
      windowMs: 60_000,
      defaultRpm: 10,
    });

    const reqAlpha = createMockReq({
      headers: { 'x-publisher-id': 'alpha' },
    } as Partial<Request>);
    const reqBeta = createMockReq({
      headers: { 'x-publisher-id': 'beta' },
    } as Partial<Request>);

    const resAlpha = createMockRes();
    const resBeta = createMockRes();

    await limiter(reqAlpha, resAlpha, next);
    await limiter(reqBeta, resBeta, next);

    expect(store.incr).toHaveBeenCalledTimes(2);
    const keys = store.incr.mock.calls.map((c) => c[0] as string);
    expect(keys[0]).toContain('publisher:alpha');
    expect(keys[1]).toContain('publisher:beta');
    expect(keys[0]).not.toEqual(keys[1]);
    expect(next).toHaveBeenCalledTimes(2);
    expect(resAlpha.statusCode).toBe(200);
    expect(resBeta.statusCode).toBe(200);
  });

  it('applies per-publisher rpm override', async () => {
    store.incr.mockResolvedValue(1);
    store.expire.mockResolvedValue(1);
    store.ttl.mockResolvedValue(60);

    const limiter = createPublisherRateLimiter({
      store: store as never,
      windowMs: 60_000,
      defaultRpm: 10,
      publisherRpm: { alpha: 3 },
    });

    const req = createMockReq({
      headers: { 'x-publisher-id': 'alpha' },
    } as Partial<Request>);
    const res = createMockRes();

    await limiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // alpha has rpm 3, so 4th request should be blocked
    store.incr.mockResolvedValue(4);
    const res2 = createMockRes();
    await limiter(req, res2, next);

    expect(res2.statusCode).toBe(429);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to default rpm when publisher has no override', async () => {
    store.incr.mockResolvedValue(1);
    store.expire.mockResolvedValue(1);
    store.ttl.mockResolvedValue(60);

    const limiter = createPublisherRateLimiter({
      store: store as never,
      windowMs: 60_000,
      defaultRpm: 2,
      publisherRpm: { alpha: 100 },
    });

    const req = createMockReq({
      headers: { 'x-publisher-id': 'beta' },
    } as Partial<Request>);
    const res = createMockRes();

    await limiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    store.incr.mockResolvedValue(3);
    const res2 = createMockRes();
    await limiter(req, res2, next);

    expect(res2.statusCode).toBe(429);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('enforces the configured cap even when rpm override is higher', async () => {
    store.incr.mockResolvedValue(1);
    store.expire.mockResolvedValue(1);
    store.ttl.mockResolvedValue(60);

    const limiter = createPublisherRateLimiter({
      store: store as never,
      windowMs: 60_000,
      defaultRpm: 10,
      publisherRpm: { alpha: 1000 },
      maxRpm: 5,
    });

    const req = createMockReq({
      headers: { 'x-publisher-id': 'alpha' },
    } as Partial<Request>);

    store.incr.mockResolvedValue(6);
    const res = createMockRes();
    await limiter(req, res, next);

    expect(res.statusCode).toBe(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('sets 429 response headers including Retry-After', async () => {
    store.incr.mockResolvedValue(11);
    store.expire.mockResolvedValue(1);
    store.ttl.mockResolvedValue(30);

    const limiter = createPublisherRateLimiter({
      store: store as never,
      windowMs: 60_000,
      defaultRpm: 10,
    });

    const req = createMockReq({
      headers: { 'x-publisher-id': 'alpha' },
    } as Partial<Request>);
    const res = createMockRes();

    await limiter(req, res, next);

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(next).not.toHaveBeenCalled();
  });

  it('fails open when the store throws', async () => {
    store.incr.mockRejectedValue(new Error('store unavailable'));
    store.expire.mockResolvedValue(1);
    store.ttl.mockResolvedValue(60);

    const limiter = createPublisherRateLimiter({
      store: store as never,
      windowMs: 60_000,
      defaultRpm: 10,
    });

    const req = createMockReq({
      headers: { 'x-publisher-id': 'alpha' },
    } as Partial<Request>);
    const res = createMockRes();

    await limiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});
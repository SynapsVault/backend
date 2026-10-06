import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

// Mock dependencies before importing the service
vi.mock('../config/env', () => ({
  env: {
    WEBHOOK_TIMEOUT_MS: 5000,
    WEBHOOK_MAX_RETRIES: 3,
    WEBHOOK_RETRY_BASE_MS: 100,
  },
}));

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../repositories/publisherRepository', () => ({
  publisherRepository: {
    findById: vi.fn(),
  },
}));

import { webhookService } from './webhookService';
import { publisherRepository } from '../repositories/publisherRepository';
import { logger } from '../utils/logger';

const mockedFindById = vi.mocked(publisherRepository.findById);

function makePublisher(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pub-1',
    name: 'Test Publisher',
    webhookUrl: 'https://example.com/webhook',
    webhookSecret: 'super-secret',
    webhookEvents: ['article.published', 'article.updated'],
    ...overrides,
  };
}

function computeSignature(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('webhookService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('target resolution from publisher config', () => {
    it('resolves the webhook URL and secret from the publisher record', async () => {
      mockedFindById.mockResolvedValue(makePublisher() as any);
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });

      await webhookService.emitToPublisher('pub-1', 'article.published', { id: 'a1' });

      expect(mockedFindById).toHaveBeenCalledWith('pub-1');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://example.com/webhook');
    });

    it('does not send when the publisher has no webhook URL configured', async () => {
      mockedFindById.mockResolvedValue(makePublisher({ webhookUrl: null }) as any);

      await webhookService.emitToPublisher('pub-1', 'article.published', { id: 'a1' });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('does not send when the publisher cannot be found', async () => {
      mockedFindById.mockResolvedValue(null as any);

      await webhookService.emitToPublisher('missing', 'article.published', { id: 'a1' });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('event filtering', () => {
    it('sends when the event is subscribed by the publisher', async () => {
      mockedFindById.mockResolvedValue(makePublisher() as any);
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });

      await webhookService.emitToPublisher('pub-1', 'article.published', { id: 'a1' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('skips delivery when the event is not subscribed', async () => {
      mockedFindById.mockResolvedValue(makePublisher() as any);

      await webhookService.emitToPublisher('pub-1', 'article.deleted', { id: 'a1' });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('delivers all events when the subscription list is empty', async () => {
      mockedFindById.mockResolvedValue(makePublisher({ webhookEvents: [] }) as any);
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });

      await webhookService.emitToPublisher('pub-1', 'anything.happened', { id: 'a1' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('delivers all events when the subscription list is null', async () => {
      mockedFindById.mockResolvedValue(makePublisher({ webhookEvents: null }) as any);
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });

      await webhookService.emitToPublisher('pub-1', 'anything.happened', { id: 'a1' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('HMAC signature header', () => {
    it('attaches a valid HMAC-SHA256 signature of the request body', async () => {
      mockedFindById.mockResolvedValue(makePublisher() as any);
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });

      await webhookService.emitToPublisher('pub-1', 'article.published', { id: 'a1' });

      const [, init] = fetchMock.mock.calls[0];
      const body = init.body as string;
      const headers = init.headers as Record<string, string>;
      const expected = computeSignature('super-secret', body);

      expect(headers['X-Webhook-Signature']).toBe(expected);
    });

    it('includes the event type and payload in the request body', async () => {
      mockedFindById.mockResolvedValue(makePublisher() as any);
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });

      await webhookService.emitToPublisher('pub-1', 'article.published', { id: 'a1' });

      const [, init] = fetchMock.mock.calls[0];
      const parsed = JSON.parse(init.body as string);
      expect(parsed.event).toBe('article.published');
      expect(parsed.data).toEqual({ id: 'a1' });
    });

    it('omits the signature header when no secret is configured', async () => {
      mockedFindById.mockResolvedValue(makePublisher({ webhookSecret: null }) as any);
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });

      await webhookService.emitToPublisher('pub-1', 'article.published', { id: 'a1' });

      const [, init] = fetchMock.mock.calls[0];
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Webhook-Signature']).toBeUndefined();
    });
  });

  describe('retry and backoff behavior', () => {
    it('retries on failure and eventually succeeds', async () => {
      vi.useFakeTimers();
      mockedFindById.mockResolvedValue(makePublisher() as any);
      fetchMock
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'ok' });

      const promise = webhookService.emitToPublisher('pub-1', 'article.published', { id: 'a1' });
      await vi.runAllTimersAsync();
      await promise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on non-2xx responses', async () => {
      vi.useFakeTimers();
      mockedFindById.mockResolvedValue(makePublisher() as any);
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' })
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'ok' });

      const promise = webhookService.emitToPublisher('pub-1', 'article.published', { id: 'a1' });
      await vi.runAllTimersAsync();
      await promise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stops after the maximum number of retries and logs an error', async () => {
      vi.useFakeTimers();
      mockedFindById.mockResolvedValue(makePublisher() as any);
      fetchMock.mockRejectedValue(new Error('always fails'));

      const promise = webhookService.emitToPublisher('pub-1', 'article.published', { id: 'a1' });
      await vi.runAllTimersAsync();
      await promise;

      // initial attempt + 3 retries
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(logger.error).toHaveBeenCalled();
    });

    it('applies exponential backoff between attempts', async () => {
      vi.useFakeTimers();
      mockedFindById.mockResolvedValue(makePublisher() as any);
      fetchMock.mockRejectedValue(new Error('network error'));

      const promise = webhookService.emitToPublisher('pub-1', 'article.published', { id: 'a1' });

      // First attempt happens immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // After base delay (100ms), second attempt
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // After doubled delay (200ms), third attempt
      await vi.advanceTimersByTimeAsync(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      await vi.runAllTimersAsync();
      await promise;
    });

    it('does not retry when the initial delivery succeeds', async () => {
      mockedFindById.mockResolvedValue(makePublisher() as any);
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });

      await webhookService.emitToPublisher('pub-1', 'article.published', { id: 'a1' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('emitToPublisher integration', () => {
    it('resolves target, filters, signs, and delivers in a single call', async () => {
      mockedFindById.mockResolvedValue(makePublisher() as any);
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });

      await webhookService.emitToPublisher('pub-1', 'article.updated', { id: 'a2', title: 'Hi' });

      expect(mockedFindById).toHaveBeenCalledWith('pub-1');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://example.com/webhook');
      expect(init.method).toBe('POST');

      const body = init.body as string;
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Webhook-Signature']).toBe(computeSignature('super-secret', body));

      const parsed = JSON.parse(body);
      expect(parsed.event).toBe('article.updated');
      expect(parsed.data).toEqual({ id: 'a2', title: 'Hi' });
    });

    it('does not throw when delivery ultimately fails', async () => {
      vi.useFakeTimers();
      mockedFindById.mockResolvedValue(makePublisher() as any);
      fetchMock.mockRejectedValue(new Error('boom'));

      const promise = webhookService.emitToPublisher('pub-1', 'article.published', { id: 'a1' });
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBeUndefined();
    });
  });
});
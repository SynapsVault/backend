import { describe, it, expect, beforeEach } from 'vitest';
import {
  businessEvents,
  errorCounters,
  requestDuration,
  recordBusinessEvent,
  recordError,
} from './metrics';

describe('metrics', () => {
  beforeEach(() => {
    businessEvents.clear();
    errorCounters.clear();
  });

  it('increments business event counters', () => {
    recordBusinessEvent('user_signup');
    recordBusinessEvent('user_signup');
    recordBusinessEvent('order_created');

    expect(businessEvents.get('user_signup')).toBe(2);
    expect(businessEvents.get('order_created')).toBe(1);
  });

  it('records error counters', () => {
    recordError('validation_error');
    recordError('validation_error');
    recordError('server_error');

    expect(errorCounters.get('validation_error')).toBe(2);
    expect(errorCounters.get('server_error')).toBe(1);
  });

  it('records error counters via requestDuration middleware', async () => {
    const middleware = requestDuration();

    const req = {} as never;
    const res = {} as never;
    const next = () => {
      throw new Error('boom');
    };

    await expect(
      middleware(req, res, next),
    ).rejects.toThrow('boom');

    expect(errorCounters.get('request_error')).toBe(1);
  });

  it('does not record an error when middleware succeeds', async () => {
    const middleware = requestDuration();

    const req = {} as never;
    const res = {} as never;
    const next = () => undefined;

    await middleware(req, res, next);

    expect(errorCounters.get('request_error')).toBeUndefined();
  });
});
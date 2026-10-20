import { randomBytes } from "node:crypto";
import { rootLogger } from "../logger.js";
import type { RateLimitConsumeResult, RateLimitStore } from "./types.js";

function buildBlockedResult(
  limit: number,
  count: number,
  oldestTimestamp: number,
  windowMs: number,
  now: number,
): RateLimitConsumeResult {
  const resetAt = oldestTimestamp + windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  return {
    allowed: false,
    limit,
    remaining: 0,
    resetAt,
    retryAfterSeconds,
  };
}

function buildAllowedResult(
  limit: number,
  count: number,
  now: number,
  windowMs: number,
): RateLimitConsumeResult {
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt: now + windowMs,
  };
}

/**
 * In-process sliding-window log. Each accepted request records a timestamp;
 * only events within the last `windowMs` count toward the limit.
 */
export class MemorySlidingWindowStore implements RateLimitStore {
  private readonly entries = new Map<string, { timestamps: number[]; windowMs: number }>();
  private readonly now: () => number;
  private readonly maxTrackedKeys: number;

  constructor(
    now: () => number = () => Date.now(),
    maxTrackedKeys = 10_000,
    sweepIntervalMs = 60_000,
  ) {
    this.now = now;
    this.maxTrackedKeys = Math.max(1, Math.trunc(maxTrackedKeys));
    const sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    sweepTimer.unref();
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitConsumeResult> {
    const now = this.now();
    const windowStart = now - windowMs;
    const active = (this.entries.get(key)?.timestamps ?? []).filter(
      (timestamp) => timestamp > windowStart,
    );

    if (active.length === 0) {
      this.entries.delete(key);
    }

    if (active.length >= limit) {
      this.setEntry(key, active, windowMs);
      return buildBlockedResult(limit, active.length, active[0]!, windowMs, now);
    }

    active.push(now);
    this.setEntry(key, active, windowMs);
    return buildAllowedResult(limit, active.length, now, windowMs);
  }

  /** Remove keys whose sliding windows no longer contain active requests. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      const active = entry.timestamps.filter((timestamp) => timestamp > now - entry.windowMs);
      if (active.length === 0) {
        this.entries.delete(key);
      } else if (active.length !== entry.timestamps.length) {
        this.entries.set(key, { ...entry, timestamps: active });
      }
    }
  }

  private setEntry(key: string, timestamps: number[], windowMs: number): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxTrackedKeys) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, { timestamps, windowMs });
  }

  /** Test helper — clear all counters. */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Redis-backed sliding-window log using a sorted set per key.
 * Safe for horizontally scaled deployments when REDIS_URL is configured.
 */
export class RedisSlidingWindowStore implements RateLimitStore {
  private client: import("redis").RedisClientType | null = null;
  private connectPromise: Promise<void>;
  private fallbackLogged = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly redisUrl: string) {
    this.connectPromise = this.connectSafely();
  }

  /** Connect without ever rejecting; log the failure once and retry with backoff. */
  private async connectSafely(): Promise<void> {
    try {
      await this.init();
      this.reconnectAttempt = 0;
      this.fallbackLogged = false;
    } catch (err) {
      if (!this.fallbackLogged) {
        this.fallbackLogged = true;
        rootLogger.warn(
          { event: "rate_limit_redis_unavailable", err },
          "Redis rate-limit store unavailable; requests will be rejected by the store until it reconnects",
        );
      }
      try {
        await this.client?.disconnect();
      } catch {
        // ignore
      }
      this.client = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectPromise = this.connectSafely();
    }, delay);
    this.reconnectTimer.unref();
  }

  private async init(): Promise<void> {
    const { createClient } = await import("redis");
    this.client = createClient({
      url: this.redisUrl,
      socket: {
        connectTimeout: 5_000,
        // Give up quickly so connect() rejects and our backoff loop takes over.
        reconnectStrategy: (retries: number) =>
          retries >= 2 ? new Error("Redis unreachable") : 200 * (retries + 1),
      },
    });
    this.client.on("error", () => {
      // Connection errors are handled per consume call; avoid crashing the process.
    });
    this.client.on("end", () => {
      if (!this.closed && this.client) {
        this.client = null;
        this.scheduleReconnect();
      }
    });
    await this.client.connect();
  }

  private consumeScript = `
    local window_start = tonumber(ARGV[1]) - tonumber(ARGV[2])
    redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, window_start)
    local current = redis.call('ZCARD', KEYS[1])
    if current >= tonumber(ARGV[3]) then
      local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
      local reset_at = tonumber(oldest[2]) + tonumber(ARGV[2])
      return {0, current, reset_at}
    end
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
    redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
    return {1, tonumber(ARGV[3]) - current - 1, tonumber(ARGV[1]) + tonumber(ARGV[2])}
  `;

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitConsumeResult> {
    await this.connectPromise;
    if (!this.client?.isOpen) {
      throw new Error("Redis rate-limit client is not connected");
    }

    const now = Date.now();
    const member = `${now}:${randomBytes(8).toString("hex")}`;
    const result = (await this.client.eval(this.consumeScript, {
      keys: [key],
      arguments: [String(now), String(windowMs), String(limit), member],
    })) as [number, number, number];

    const [allowedFlag, secondValue, resetAt] = result;
    if (allowedFlag === 1) {
      return {
        allowed: true,
        limit,
        remaining: Math.max(0, secondValue),
        resetAt,
      };
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt,
      retryAfterSeconds,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.connectPromise;
    if (this.client?.isOpen) {
      await this.client.quit();
    }
  }
}

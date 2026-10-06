export interface RateLimitConsumeResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch milliseconds when the client can retry or the window fully resets. */
  resetAt: number;
  retryAfterSeconds?: number;
}

export interface RateLimitStore {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitConsumeResult>;
  close?(): Promise<void>;
}

/**
 * Optional per-publisher rate limit configuration.
 *
 * When provided, publisher-aware limiters use these values instead of the
 * global defaults. Both fields are optional so callers can override only the
 * dimension they care about.
 */
export interface PublisherRateLimitConfig {
  /** Requests per minute allowed for the publisher. */
  rpm?: number;
  /** Sliding/fixed window size in milliseconds. */
  windowMs?: number;
}

/**
 * Resolves the effective limit and window for a given publisher, falling back
 * to global defaults when no publisher-specific override is configured.
 */
export type ResolvePublisherRateLimit = (
  publisherId: string,
  config?: PublisherRateLimitConfig,
) => { limit: number; windowMs: number };
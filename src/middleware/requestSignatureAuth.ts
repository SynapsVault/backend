import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { publishers } from "../db/schema.js";
import { hashApiKey } from "../utils/crypto.js";
import { decryptSigningSecret } from "../utils/crypto.js";
import { signingKeyring } from "../lib/secretKeys.js";
import { AppError } from "../lib/errors.js";
import {
  EMPTY_BODY_HASH,
  getRequestPath,
  hashFile,
  hashMultipartBody,
  hashRequestBody,
  isTimestampWithinSkew,
  verifyRequestSignature,
} from "../utils/requestSignature.js";
import { rootLogger } from "../lib/logger.js";
import { businessEventsTotal } from "../lib/metrics.js";
import { cleanupRequestUpload } from "./uploadGuards.js";

declare global {
  namespace Express {
    interface Request {
      /** Raw request body bytes captured by express.json verify (JSON routes). */
      rawBody?: Buffer;
    }
  }
}

// ── Replay cache ─────────────────────────────────────────────────────────────
//
// #43: use Redis SET NX + TTL when REDIS_URL is set so replay protection works
// across replicas. Use an in-process Map when Redis is not configured (single
// replica), pruned on a timer instead of on every request. When Redis is
// configured but unavailable, REPLAY_PROTECTION_FAILURE_MODE decides between
// rejecting (closed) and the local Map (open) — see onSharedReplayUnavailable.

/** In-process fallback: signature → expiry timestamp (ms). */
const inMemoryCache = new Map<string, number>();

/** Prune expired entries on a timer (every 60 s) — not on every request (#43). */
let pruneTimer: NodeJS.Timeout | null = setInterval(() => {
  const now = Date.now();
  for (const [sig, expiresAt] of inMemoryCache) {
    if (expiresAt <= now) inMemoryCache.delete(sig);
  }
}, 60_000);
pruneTimer.unref(); // don't keep the process alive

type RedisClient = import("redis").RedisClientType;

let replayStoreClosed = false;
let redisClient: RedisClient | null = null;
let redisConnectPromise: Promise<RedisClient | null> | null = null;

/** Open one shared Redis connection; resolves null (and allows a retry) on failure. */
function connectRedis(): Promise<RedisClient | null> {
  return (async () => {
    try {
      const { createClient } = await import("redis");
      const client = createClient({
        url: config.REDIS_URL,
        // Fail commands fast while disconnected instead of queueing them, so
        // a replay check never silently waits on a dead connection.
        disableOfflineQueue: true,
        socket: {
          connectTimeout: config.REPLAY_REDIS_CONNECT_TIMEOUT_MS,
          reconnectStrategy: (retries: number) =>
            retries >= 3 ? new Error("Redis unreachable") : 200 * (retries + 1),
        },
      }) as RedisClient;
      client.on("error", () => {});
      client.on("end", () => {
        if (redisClient === client) {
          redisClient = null;
          redisConnectPromise = null;
        }
      });
      await client.connect();
      if (replayStoreClosed) { await quitOrDisconnect(client); return null; }
      redisClient = client;
      return client;
    } catch (err) {
      rootLogger.warn({ event: "replay_cache_redis_unavailable", err }, "Redis replay cache unavailable");
      redisClient = null;
      redisConnectPromise = null;
      return null;
    }
  })();
}

const TIMED_OUT = Symbol("timed-out");

/** Resolve with `promise`, or with TIMED_OUT after `ms` (the underlying work continues). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Return a ready shared Redis client, waiting (bounded by
 * REPLAY_REDIS_CONNECT_TIMEOUT_MS) for the initial connection so cold-start
 * requests use the shared store instead of per-process memory. Returns null
 * when Redis is not configured, or not ready within the bound.
 */
async function getRedisClient(): Promise<RedisClient | null> {
  if (replayStoreClosed || !config.REDIS_URL) return null;
  if (redisClient?.isReady) return redisClient;

  // A client that exhausted its reconnect budget is closed for good — drop
  // it so the next call opens a fresh connection (recovery after an outage).
  if (redisClient && !redisClient.isOpen) {
    const stale = redisClient;
    redisClient = null;
    redisConnectPromise = null;
    void stale.disconnect().catch(() => {});
  }

  if (!redisConnectPromise) redisConnectPromise = connectRedis();
  const client = await withTimeout(redisConnectPromise, config.REPLAY_REDIS_CONNECT_TIMEOUT_MS);
  return client !== TIMED_OUT && client?.isReady ? client : null;
}

/** Shared replay store could not give a cross-replica answer (fail-closed). */
class ReplayStoreUnavailableError extends Error {}

/**
 * Handle a request whose shared (Redis) replay check could not run.
 *
 * REPLAY_PROTECTION_FAILURE_MODE decides the tradeoff:
 *   closed — reject the mutation (503). No signature can be accepted twice
 *            across replicas, at the cost of signed mutations being
 *            unavailable while Redis is down.
 *   open   — fall back to this process's local cache. Mutations stay
 *            available, but a signature replayed to a *different* replica
 *            during the outage can be accepted again.
 */
function onSharedReplayUnavailable(reason: string, err?: unknown): void {
  const closed = config.REPLAY_PROTECTION_FAILURE_MODE === "closed";
  businessEventsTotal.inc({ event: "replay_check.degraded", outcome: closed ? "rejected" : "local_fallback" });
  rootLogger.warn(
    { event: "replay_cache_redis_degraded", reason, mode: config.REPLAY_PROTECTION_FAILURE_MODE, err },
    closed
      ? "shared replay check unavailable — rejecting signed mutation (fail-closed)"
      : "shared replay check unavailable — falling back to in-process cache (fail-open)",
  );
  if (closed) throw new ReplayStoreUnavailableError(reason);
}

/** Gracefully QUIT a ready client; force-close one that is not ready. */
async function quitOrDisconnect(client: RedisClient): Promise<void> {
  if (!client.isOpen) return;
  try {
    if (client.isReady) {
      await client.quit();
    } else {
      await client.disconnect();
    }
  } catch {
    try {
      await client.disconnect();
    } catch {
      // already closed
    }
  }
}

/**
 * Close the signature replay store: stop the prune timer, prevent any further
 * connect/reconnect attempts, and close the Redis connection. An in-flight
 * connect attempt is awaited (bounded by connectTimeout) and its client is
 * closed as soon as it settles, so no sockets or timers are left behind.
 * Safe to call more than once. After closing, replay checks fall back to the
 * in-process cache.
 */
export async function closeSignatureReplayStore(): Promise<void> {
  replayStoreClosed = true;
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }

  const client = redisClient;
  redisClient = null;
  const connecting = redisConnectPromise;
  redisConnectPromise = null;

  if (client) await quitOrDisconnect(client);
  if (connecting) await connecting.catch(() => {});
  inMemoryCache.clear();
}

/**
 * Check for a replayed signature, and mark it as seen.
 * Returns true when the signature has already been used (replay).
 * Throws ReplayStoreUnavailableError when shared mode is configured, Redis
 * cannot answer, and the policy is fail-closed.
 */
async function checkAndMarkReplay(signature: string, ttlMs: number): Promise<boolean> {
  if (config.REDIS_URL) {
    const redis = await getRedisClient();
    if (!redis) {
      onSharedReplayUnavailable("redis_not_ready");
    } else {
      // SET NX with TTL — atomic; works across replicas (#43).
      const key = `replay:${signature}`;
      const ttlSeconds = Math.ceil(ttlMs / 1000);
      try {
        const set = await withTimeout(
          redis.set(key, "1", { NX: true, EX: ttlSeconds }),
          config.REPLAY_REDIS_CONNECT_TIMEOUT_MS,
        );
        if (set === TIMED_OUT) throw new Error("Redis replay check timed out");
        // set === null means key already existed → replay
        return set === null;
      } catch (err) {
        onSharedReplayUnavailable("redis_command_failed", err);
      }
    }
  }

  // In-process store: the only store when REDIS_URL is unset, or the
  // fail-open fallback.
  const now = Date.now();
  if (inMemoryCache.has(signature)) return true;
  inMemoryCache.set(signature, now + ttlMs);
  return false;
}

// ── Body hashing ─────────────────────────────────────────────────────────────

async function resolveBodyHash(req: Request): Promise<string> {
  const contentType = req.headers["content-type"] ?? "";

  if (contentType.includes("multipart/form-data")) {
    const fields = (req.body ?? {}) as Record<string, unknown>;
    const file = req.file as Express.Multer.File | undefined;
    if (!file) return hashMultipartBody(fields);
    // multer diskStorage exposes `path` (no `buffer`); hash the bytes that were
    // actually written to disk using bounded streaming reads.
    if (typeof file.path === "string" && file.path !== "") {
      return hashMultipartBody(fields, { sha256: await hashFile(file.path) });
    }
    if (Buffer.isBuffer(file.buffer)) {
      return hashMultipartBody(fields, { buffer: file.buffer });
    }
    throw new Error("Uploaded file has neither a disk path nor an in-memory buffer");
  }

  if (req.rawBody !== undefined) {
    return hashRequestBody(req.rawBody);
  }

  if (req.method === "DELETE" || req.method === "GET") {
    return EMPTY_BODY_HASH;
  }

  return EMPTY_BODY_HASH;
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * HMAC-SHA256 request signature verification for publisher mutations (#42, #43).
 *
 * When REQUIRE_REQUEST_SIGNATURE is false (default outside production), this
 * middleware is a no-op.
 *
 * Expects:
 *   x-api-key     — publisher API key (identifies the publisher to look up their signing secret)
 *   X-Timestamp   — unix seconds
 *   X-Signature   — hex HMAC-SHA256 of the canonical string, keyed by the publisher's signing secret
 *
 * The HMAC secret is the publisher's per-record signing secret (#42), NOT the
 * raw API key. Signatures made with the API key alone are rejected.
 */
export async function requestSignatureAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.REQUIRE_REQUEST_SIGNATURE) {
    next();
    return;
  }

  const fail = (message: string) => {
    // #230: signature middleware runs after the disk upload but before the
    // publish handler, so its finally-block cleanup never runs on rejection.
    // Run the idempotent cleanup registered at upload time before erroring.
    void cleanupRequestUpload(req);
    next(new AppError("UNAUTHORIZED", message));
  };

  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey !== "string") {
    fail("Missing x-api-key header");
    return;
  }

  const timestampHeader = req.headers["x-timestamp"];
  const signatureHeader = req.headers["x-signature"];
  if (
    !timestampHeader || typeof timestampHeader !== "string" ||
    !signatureHeader || typeof signatureHeader !== "string"
  ) {
    fail("Missing request signature headers");
    return;
  }

  const timestampSeconds = Number(timestampHeader);
  if (!/^\d+$/.test(timestampHeader) || !Number.isSafeInteger(timestampSeconds)) {
    fail("Invalid request timestamp");
    return;
  }
  const now = Date.now();
  if (!isTimestampWithinSkew(timestampSeconds, now, config.SIGNATURE_MAX_SKEW_MS)) {
    fail("Request timestamp outside allowed window");
    return;
  }

  // Look up the publisher by API key hash to retrieve their signing secret (#42).
  let signingSecret: string;
  try {
    const apiKeyHash = hashApiKey(apiKey);
    const [row] = await db
      .select({ signingSecret: publishers.signingSecret })
      .from(publishers)
      .where(eq(publishers.apiKeyHash, apiKeyHash))
      .limit(1);

    if (!row || !row.signingSecret) {
      fail("No signing secret found — rotate your signing secret first");
      return;
    }

    // Decrypt if SIGNING_SECRET_KEY is configured (#42). Legacy keys from
    // SIGNING_SECRET_LEGACY_KEYS are accepted during a key rotation.
    const keyring = signingKeyring();
    if (keyring) {
      const plain = decryptSigningSecret(row.signingSecret, keyring);
      if (!plain) {
        fail("Invalid signing secret configuration");
        return;
      }
      signingSecret = plain;
    } else {
      signingSecret = row.signingSecret;
    }
  } catch {
    fail("Failed to load signing secret");
    return;
  }

  let bodyHash: string;
  try {
    bodyHash = await resolveBodyHash(req);
  } catch (err) {
    rootLogger.warn({ event: "request_signature_body_hash_failed", err }, "failed to hash request body for signature check");
    fail("Unable to verify request body");
    return;
  }

  const idempotencyHeader = req.headers["idempotency-key"];
  const valid = verifyRequestSignature({
    secret: signingSecret,
    method: req.method,
    path: getRequestPath(req.originalUrl),
    timestamp: timestampHeader,
    bodyHash,
    idempotencyKey: typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
    signature: signatureHeader,
  });
  if (!valid) {
    fail("Invalid request signature");
    return;
  }

  // Replay protection (#43).
  try {
    const isReplay = await checkAndMarkReplay(signatureHeader, config.SIGNATURE_MAX_SKEW_MS * 2);
    if (isReplay) {
      fail("Request signature already used");
      return;
    }
  } catch (err) {
    if (err instanceof ReplayStoreUnavailableError) {
      void cleanupRequestUpload(req);
      next(new AppError(
        "SERVICE_UNAVAILABLE",
        "Replay protection is temporarily unavailable; retry the request shortly",
      ));
      return;
    }
    fail("Replay check failed");
    return;
  }

  next();
}

/** Test helper — forget previously accepted signatures and drop the Redis client. */
export function __resetSignatureReplayCache(): void {
  inMemoryCache.clear();
  const client = redisClient;
  redisClient = null;
  redisConnectPromise = null;
  if (client) void client.disconnect().catch(() => {});
}

/** Test helper — trigger the Redis connection and report replay-store state. */
export async function __replayStoreStateForTests(): Promise<{
  closed: boolean;
  pruneTimerActive: boolean;
  client: RedisClient | null;
}> {
  await getRedisClient();
  if (redisConnectPromise) await redisConnectPromise;
  return { closed: replayStoreClosed, pruneTimerActive: pruneTimer !== null, client: redisClient };
}

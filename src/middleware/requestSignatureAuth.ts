import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { AppError } from "../utils/AppError.js";
import {
  EMPTY_BODY_HASH,
  getRequestPath,
  hashMultipartBody,
  hashRequestBody,
  isTimestampWithinSkew,
  verifyRequestSignature,
} from "../utils/requestSignature.js";

/**
 * In-memory replay-protection cache keyed by `${signature}:${timestamp}`.
 * Entries expire after the signature skew window, after which the same
 * signature+timestamp pair is no longer considered a replay.
 */
const seenSignatures = new Map<string, number>();

function pruneSeenSignatures(now: number): void {
  for (const [key, expiresAt] of seenSignatures) {
    if (expiresAt <= now) {
      seenSignatures.delete(key);
    }
  }
}

function isReplay(key: string, now: number): boolean {
  pruneSeenSignatures(now);
  const expiresAt = seenSignatures.get(key);
  if (expiresAt !== undefined && expiresAt > now) {
    return true;
  }
  seenSignatures.set(key, now + config.SIGNATURE_MAX_SKEW_MS);
  return false;
}

declare global {
  namespace Express {
    interface Request {
      /** Raw request body bytes captured by express.json verify (JSON routes). */
      rawBody?: Buffer;
    }
  }
}

function resolveBodyHash(req: Request): string {
  const contentType = req.headers["content-type"] ?? "";

  if (contentType.includes("multipart/form-data")) {
    const file = req.file as Express.Multer.File | undefined;
    return hashMultipartBody(
      req.body as Record<string, unknown>,
      file ? { buffer: file.buffer } : undefined,
    );
  }

  if (req.rawBody !== undefined) {
    return hashRequestBody(req.rawBody);
  }

  if (req.method === "DELETE" || req.method === "GET") {
    return EMPTY_BODY_HASH;
  }

  return EMPTY_BODY_HASH;
}

/**
 * Optional HMAC-SHA256 request signature verification for publisher mutations.
 * When REQUIRE_REQUEST_SIGNATURE is false (default), this middleware is a no-op.
 *
 * Expects X-Timestamp (unix seconds) and X-Signature (hex HMAC) headers.
 * The API key (x-api-key) is the HMAC secret.
 */
export function requestSignatureAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.REQUIRE_REQUEST_SIGNATURE) {
    next();
    return;
  }

  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey !== "string") {
    throw new AppError("UNAUTHORIZED", "Missing x-api-key header");
  }

  const timestampHeader = req.headers["x-timestamp"];
  const signatureHeader = req.headers["x-signature"];

  if (!timestampHeader || typeof timestampHeader !== "string") {
    throw new AppError("UNAUTHORIZED", "Missing X-Timestamp header");
  }
  if (!signatureHeader || typeof signatureHeader !== "string") {
    throw new AppError("UNAUTHORIZED", "Missing X-Signature header");
  }

  const timestampSeconds = Number(timestampHeader);
  if (!isTimestampWithinSkew(timestampSeconds, Date.now(), config.SIGNATURE_MAX_SKEW_MS)) {
    throw new AppError("UNAUTHORIZED", "Request timestamp outside allowed window");
  }

  const nonceHeader = req.headers["x-nonce"];
  const nonce = typeof nonceHeader === "string" ? nonceHeader : undefined;
  const replayKey = `${signatureHeader}:${timestampHeader}${nonce ? `:${nonce}` : ""}`;
  if (isReplay(replayKey, Date.now())) {
    throw new AppError("UNAUTHORIZED", "Request signature has already been used");
  }

  const bodyHash = resolveBodyHash(req);
  const path = getRequestPath(req.originalUrl);
  const idempotencyHeader = req.headers["idempotency-key"];
  const idempotencyKey = typeof idempotencyHeader === "string" ? idempotencyHeader : undefined;

  const valid = verifyRequestSignature({
    secret: apiKey,
    method: req.method,
    path,
    timestamp: timestampHeader,
    bodyHash,
    idempotencyKey,
    signature: signatureHeader,
  });

  if (!valid) {
    throw new AppError("UNAUTHORIZED", "Invalid request signature");
  }

  next();
}

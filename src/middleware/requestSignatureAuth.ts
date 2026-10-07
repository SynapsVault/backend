import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import {
  EMPTY_BODY_HASH,
  getRequestPath,
  hashMultipartBody,
  hashRequestBody,
  isTimestampWithinSkew,
  verifyRequestSignature,
} from "../utils/requestSignature.js";

/**
 * Signatures accepted within the skew window, used for replay protection.
 * In-memory, so it only protects a single instance; only *valid* signatures
 * are recorded, so the set can't be flooded with garbage.
 */
const seenSignatures = new Map<string, number>();

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

  const fail = (message: string) => next(new AppError("UNAUTHORIZED", message));

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

  const idempotencyHeader = req.headers["idempotency-key"];
  const valid = verifyRequestSignature({
    secret: apiKey,
    method: req.method,
    path: getRequestPath(req.originalUrl),
    timestamp: timestampHeader,
    bodyHash: resolveBodyHash(req),
    idempotencyKey: typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
    signature: signatureHeader,
  });
  if (!valid) {
    fail("Invalid request signature");
    return;
  }

  pruneExpired(seenSignatures, now);
  if (seenSignatures.has(signatureHeader)) {
    fail("Request signature already used");
    return;
  }
  seenSignatures.set(signatureHeader, now + config.SIGNATURE_MAX_SKEW_MS);

  next();
}

/** Test helper — forget previously accepted signatures. */
export function __resetSignatureReplayCache(): void {
  seenSignatures.clear();
}

function pruneExpired(entries: Map<string, number>, now: number): void {
  for (const [key, expiresAt] of entries) {
    if (expiresAt <= now) entries.delete(key);
  }
}

import cors, { type CorsOptions } from "cors";
import { config } from "./config.js";
import { rootLogger } from "./lib/logger.js";

/** Headers clients may send for x402 payment retries and API auth. */
export const X402_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "x-api-key",
  "x-timestamp",
  "x-signature",
  "Idempotency-Key",
  "x-request-id",
  "PAYMENT-SIGNATURE",
  "X-Payment",
] as const;

/** Headers the server exposes for x402 flows and payment receipts. */
export const X402_EXPOSED_HEADERS = [
  "PAYMENT-REQUIRED",
  "PAYMENT-RESPONSE",
  "X-PAYMENT-RESPONSE",
  "x-request-id",
  "X-Payment-Id",
  "X-Payment-Amount",
  "X-Payment-Recipient",
] as const;

/** Normalizes an origin as browsers send it: no trailing slash or path. */
function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

export function parseAllowedOrigins(raw: string | undefined, fallback: string): string[] {
  if (raw?.trim()) {
    return raw.split(",").map(normalizeOrigin).filter(Boolean);
  }
  return [normalizeOrigin(fallback)].filter(Boolean);
}

/**
 * Matches an Origin header against the allowlist. Entries may use a leading
 * `*.` wildcard for the host (e.g. `https://*.vercel.app` for preview deploys).
 */
export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalized = normalizeOrigin(origin);
  return allowedOrigins.some((allowed) => {
    if (allowed === "*" || allowed === normalized) return true;
    const wildcard = allowed.match(/^(https?:\/\/)\*\.(.+)$/);
    if (!wildcard) return false;
    const [, scheme, suffix] = wildcard;
    return normalized.startsWith(scheme!) && normalized.endsWith(`.${suffix}`);
  });
}

const warnedOrigins = new Set<string>();

export function createCorsOptions(): CorsOptions {
  const isProduction = config.NODE_ENV === "production";
  const allowedOrigins = parseAllowedOrigins(config.ALLOWED_ORIGINS, config.WEB_APP_URL);
  // The web app must always be able to reach the API, even when
  // ALLOWED_ORIGINS lists only extra origins.
  if (config.WEB_APP_URL) allowedOrigins.push(normalizeOrigin(config.WEB_APP_URL));

  return {
    origin: isProduction
      ? (origin, callback) => {
          // Non-browser clients (curl, server-side fetch) omit Origin.
          if (!origin || isOriginAllowed(origin, allowedOrigins)) {
            callback(null, true);
            return;
          }
          // Omit CORS headers (the browser blocks the response) rather than
          // erroring, which would turn every such request into a 500.
          if (!warnedOrigins.has(origin)) {
            warnedOrigins.add(origin);
            rootLogger.warn(
              { event: "cors_origin_rejected", origin, allowedOrigins },
              "origin not in ALLOWED_ORIGINS / WEB_APP_URL; browser requests will be blocked",
            );
          }
          callback(null, false);
        }
      : true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: isProduction ? [...X402_ALLOWED_HEADERS] : "*",
    exposedHeaders: isProduction ? [...X402_EXPOSED_HEADERS] : "*",
  };
}

export function corsMiddleware() {
  return cors(createCorsOptions());
}

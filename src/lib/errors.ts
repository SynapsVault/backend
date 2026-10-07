/**
 * Application error type and the JSON error body the API returns.
 *
 * Every error response keeps the long-standing `{ error: "<message>" }` shape
 * so existing clients keep working, and adds a machine-readable `code`, an
 * optional `details` payload and the request id for support/debugging.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "UPSTREAM_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "GATEWAY_TIMEOUT";

export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};

export interface ErrorResponseBody {
  error: string;
  code: ErrorCode;
  details?: unknown;
  requestId?: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** HTTP status for any thrown value (honours `status`/`statusCode` set by libs like body-parser). */
export function getStatusCode(error: unknown): number {
  if (isAppError(error)) return error.status;
  if (typeof error === "object" && error !== null) {
    const status = (error as { status?: unknown; statusCode?: unknown }).status
      ?? (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 600) return status;
  }
  return 500;
}

function codeForStatus(status: number): ErrorCode {
  const match = (Object.entries(ERROR_STATUS) as [ErrorCode, number][]).find(([, s]) => s === status);
  if (match) return match[0];
  return status >= 500 ? "INTERNAL_ERROR" : "VALIDATION_ERROR";
}

/**
 * Converts any thrown value into the public error body. Messages of
 * unexpected (non-AppError) 5xx errors are never exposed to clients.
 */
export function serializeError(error: unknown, requestId?: string): ErrorResponseBody {
  const status = getStatusCode(error);
  let body: ErrorResponseBody;

  if (isAppError(error)) {
    body = { error: error.message, code: error.code };
    if (error.details !== undefined) body.details = error.details;
  } else if (status < 500 && error instanceof Error && error.message) {
    // Client errors raised by middleware (e.g. malformed JSON, body too large).
    body = { error: error.message, code: codeForStatus(status) };
  } else {
    body = { error: "Internal server error", code: "INTERNAL_ERROR" };
  }

  if (requestId) body.requestId = requestId;
  return body;
}

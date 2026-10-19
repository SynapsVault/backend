import { AppError } from "./errors.js";

// Idempotency-Key format (#72): 1 to 255 characters from [A-Za-z0-9_-].
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

// Returns the validated key, or undefined when the header is absent.
// Throws a 400 VALIDATION_ERROR when the header is present but malformed.
export function parseIdempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!isValidIdempotencyKey(raw)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Invalid Idempotency-Key: must be 1-255 characters from [A-Za-z0-9_-]",
    );
  }
  return raw;
}

import type { Response } from "express";

// Per-request AbortSignal (#73). The timeout middleware aborts it when the
// request times out so handlers can stop starting new work (storage writes,
// database inserts) for a request the client has already been told failed.
const KEY = "requestAbortSignal";

export function setRequestSignal(res: Response, signal: AbortSignal): void {
  (res.locals ??= {})[KEY] = signal;
}

export function getRequestSignal(res: Response): AbortSignal | undefined {
  return res.locals?.[KEY] as AbortSignal | undefined;
}

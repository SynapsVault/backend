import type { NextFunction, Request, Response } from "express";
import { getStatusCode, serializeError } from "../lib/errors.js";
import { getLogger, getRequestId } from "../lib/logger.js";
import { captureServerException } from "../lib/sentry.js";

/**
 * Global error handler. Converts thrown errors (AppError or otherwise) into the
 * standard JSON error body; 5xx errors are logged and reported to Sentry.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const status = getStatusCode(err);
  const log = getLogger();
  const context = { method: req.method, path: req.originalUrl, status };

  if (status >= 500) {
    log.error({ err, ...context, event: "unhandled_error" }, "request failed");
    captureServerException(err);
  } else {
    log.warn({ ...context, event: "client_error", reason: (err as Error)?.message }, "request rejected");
  }

  if (res.headersSent) {
    next(err);
    return;
  }

  res.status(status).json(serializeError(err, getRequestId()));
}

/** Fallback for unmatched routes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: `Route ${req.method} ${req.path} not found`,
    code: "NOT_FOUND",
    ...(getRequestId() ? { requestId: getRequestId() } : {}),
  });
}

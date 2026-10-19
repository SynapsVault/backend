import type { NextFunction, Request, Response } from "express";
import { getLogger } from "../lib/logger.js";
import { getRequestLogContext } from "../lib/requestLogContext.js";
import { setRequestSignal } from "../lib/requestAbort.js";

// Per-request timeout (issue #113). When a slow upstream (RPC, facilitator,
// storage) keeps a request open past the limit, respond 503 instead of letting
// the connection hang. The timer is cleared once the response finishes (or the
// client disconnects) so completed requests never trip it.
//
// Abort semantics (#73): on timeout the request's AbortSignal (see
// lib/requestAbort.ts) is aborted. Handlers check it before starting new work,
// so a publish that has not yet created anything is cancelled and its
// idempotency key released. Work that is already past that point is not
// interrupted: it completes, records its final outcome under the idempotency
// key (so a retry returns the committed result rather than a stale
// "in progress" 409), and skips writing to the already-answered response.
export function requestTimeout(ms: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const controller = new AbortController();
    setRequestSignal(res, controller.signal);

    const timer = setTimeout(() => {
      controller.abort();
      // Headers may already be on the wire (e.g. a streamed download in
      // progress) — don't try to rewrite the response in that case.
      if (res.headersSent) return;

      getLogger().warn(
        {
          event: "request_timeout",
          method: req.method,
          ...getRequestLogContext(req),
          timeoutMs: ms,
        },
        "request timed out",
      );

      res.setHeader("Retry-After", String(Math.ceil(ms / 1000)));
      res.status(503).json({ error: "Request timeout" });
    }, ms);

    const clear = () => clearTimeout(timer);
    res.on("finish", clear);
    res.on("close", clear);

    next();
  };
}

import type { Request, Response, NextFunction } from "express";
import { httpErrorsTotal, httpRequestDuration } from "../lib/metrics.js";

export function requestDurationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    // Use the matched route pattern (e.g. /resources/:id) to keep label
    // cardinality bounded; unmatched paths collapse into a single bucket.
    const route = (req.route?.path as string | undefined) ?? "unmatched";
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    end(labels);
    if (res.statusCode >= 400) {
      httpErrorsTotal.inc(labels);
    }
  });
  next();
}

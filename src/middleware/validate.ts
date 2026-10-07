import type { RequestHandler } from "express";
import type { z } from "zod/v4";
import { AppError } from "../lib/errors.js";

export function validate<T extends z.ZodType>(schema: T): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      next(
        new AppError(
          "VALIDATION_ERROR",
          issue ? `${where}${issue.message}` : "Invalid request body",
          parsed.error.format(),
        ),
      );
      return;
    }
    req.body = parsed.data;
    next();
  };
}

export function validateFields<T extends z.ZodType>(
  schema: T,
  source: Record<string, unknown>,
): { success: true; data: z.infer<T> } | { success: false; error: z.ZodError } {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    return { success: false, error: parsed.error };
  }
  return { success: true, data: parsed.data };
}

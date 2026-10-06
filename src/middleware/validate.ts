import type { RequestHandler } from "express";
import type { z } from "zod/v4";
import { AppError } from "../errors/AppError";

export function validate<T extends z.ZodType>(schema: T): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(
        new AppError("VALIDATION_ERROR", "Validation failed", {
          details: parsed.error.format(),
        }),
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
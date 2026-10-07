import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { publishers } from "../db/schema.js";
import { hashApiKey } from "../utils/crypto.js";
import { AppError } from "../lib/errors.js";

declare global {
  namespace Express {
    interface Request {
      publisher?: typeof publishers.$inferSelect;
    }
  }
}

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-api-key"];

  if (!key || typeof key !== "string") {
    throw new AppError("UNAUTHORIZED", "Missing x-api-key header");
  }

  const hash = hashApiKey(key);
  const publisher = await db
    .select()
    .from(publishers)
    .where(eq(publishers.apiKeyHash, hash))
    .then((rows) => rows[0]);

  if (!publisher) {
    throw new AppError("UNAUTHORIZED", "Invalid API key");
  }

  req.publisher = publisher;
  next();
}
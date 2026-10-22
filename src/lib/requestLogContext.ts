import type { Request } from "express";

const SAFE_QUERY_KEYS = new Set([
  "limit",
  "maxPrice",
  "minPrice",
  "offset",
  "owner",
  "page",
  "resourceType",
  "search",
  "sort",
  "verificationStatus",
]);

function isSafeQueryValue(value: unknown): value is string | string[] {
  return typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

export function getRequestLogContext(req: Request): {
  path: string;
  query?: Record<string, string | string[]>;
} {
  const query = Object.fromEntries(
    Object.entries(req.query ?? {}).filter(
      ([key, value]) => SAFE_QUERY_KEYS.has(key) && isSafeQueryValue(value),
    ),
  ) as Record<string, string | string[]>;

  return {
    path: req.path,
    ...(Object.keys(query).length > 0 ? { query } : {}),
  };
}
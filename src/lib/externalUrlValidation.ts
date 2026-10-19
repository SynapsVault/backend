import { z } from "zod/v4";

/** A URL that must use the http: or https: scheme (rejects javascript:, data:, etc.). */
export const httpUrlSchema = z.url().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "URL must use http or https" },
);

import { describe, it, expect } from "vitest";
import { httpUrlSchema } from "./externalUrlValidation.js";

describe("httpUrlSchema", () => {
  it("accepts http and https URLs", () => {
    expect(httpUrlSchema.safeParse("https://example.com/x").success).toBe(true);
    expect(httpUrlSchema.safeParse("http://example.com").success).toBe(true);
  });
  it("rejects javascript: and data: URLs", () => {
    expect(httpUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(httpUrlSchema.safeParse("data:text/html,<script>1</script>").success).toBe(false);
  });
});

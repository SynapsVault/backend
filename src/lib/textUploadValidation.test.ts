import { describe, expect, it } from "vitest";
import { validateTextContent } from "./textUploadValidation.js";

describe("validateTextContent", () => {
  it("accepts plain text and markdown", () => {
    expect(validateTextContent(Buffer.from("# Title\n\nHello 1 < 2 and 3 > 2"))).toBeNull();
  });
  it("rejects HTML", () => {
    expect(validateTextContent(Buffer.from("<html><body>x</body></html>"))).not.toBeNull();
    expect(validateTextContent(Buffer.from("hi <script>alert(1)</script>"))).not.toBeNull();
  });
  it("rejects invalid UTF-8 and NUL bytes", () => {
    expect(validateTextContent(Buffer.from([0xff, 0xfe, 0xfd]))).not.toBeNull();
    expect(validateTextContent(Buffer.from("a\u0000b"))).not.toBeNull();
  });
});

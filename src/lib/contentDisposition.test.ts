import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "./contentDisposition.js";

describe("attachmentDisposition", () => {
  it("escapes quotes and semicolons", () => {
    const h = attachmentDisposition('a"b;c.pdf');
    expect(h).toBe(`attachment; filename="a_b_c.pdf"; filename*=UTF-8''a%22b%3Bc.pdf`);
  });
  it("encodes non-ASCII names", () => {
    const h = attachmentDisposition("résumé.pdf");
    expect(h).toContain('filename="r_sum_.pdf"');
    expect(h).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });
  it("strips CR/LF", () => {
    expect(attachmentDisposition("a\r\nb.txt")).not.toMatch(/[\r\n]/);
  });
});

/**
 * Validation for text/* uploads (#62): content must be valid UTF-8, free of
 * NUL bytes, and must not look like HTML/SVG/script markup.
 */

const MARKUP_PATTERN =
  /<\s*(!doctype\s+html|html|head|body|script|iframe|object|embed|svg|style|link|meta|img|form|a\s)\b|<\s*\?xml|javascript:/i;

export function isTextMimeType(mime: string): boolean {
  return mime.startsWith("text/");
}

/** Returns an error message when the buffer is not acceptable text, else null. */
export function validateTextContent(buffer: Buffer): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return "Text uploads must be valid UTF-8";
  }
  if (text.includes("\u0000")) {
    return "Text uploads must not contain binary data";
  }
  if (MARKUP_PATTERN.test(text)) {
    return "Text uploads must not contain HTML or script markup";
  }
  return null;
}

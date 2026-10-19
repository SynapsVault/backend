/**
 * Build an RFC 6266 attachment Content-Disposition header (#61): an ASCII
 * fallback in `filename` and the percent-encoded UTF-8 name in `filename*`.
 */
export function attachmentDisposition(filename: string): string {
  const clean = filename.replace(/[\r\n\u0000-\u001f\u007f]/g, "");
  const fallback =
    clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\;%]/g, "_").trim() || "download";
  const encoded = encodeURIComponent(clean || "download").replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

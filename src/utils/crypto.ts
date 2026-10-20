import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";

export function generateApiKey(): string {
  return `mv_${randomBytes(32).toString("hex")}`;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function hashContentUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export function calculateContentHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * SHA-256 over file bytes + title for the on-chain metadata integrity anchor.
 * The title is encoded as UTF-8 and prepended before the file bytes so the
 * hash changes if the title changes even when the bytes are identical.
 */
export function hashFileResource(buffer: Buffer, title: string): string {
  return createHash("sha256").update(Buffer.from(title, "utf8")).update(buffer).digest("hex");
}

/**
 * SHA-256 of normalized external URL + title for link resource metadata.
 * Normalization: lowercase scheme+host, strip trailing slash from pathname,
 * sort query parameters alphabetically so equivalent URLs produce the same hash.
 */
export function hashLinkResource(url: string, title: string): string {
  const normalized = normalizeUrl(url);
  return createHash("sha256").update(normalized).update(Buffer.from(title, "utf8")).digest("hex");
}

function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hostname = u.hostname.toLowerCase();
  u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  const sorted = Array.from(u.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  sorted.forEach(([k, v]) => u.searchParams.append(k, v));
  return u.toString();
}

// ── Signing secret helpers (#42) ────────────────────────────────────────────

/** Generate a per-publisher HMAC signing secret (shown once, never stored raw). */
export function generateSigningSecret(): string {
  return `svs_${randomBytes(32).toString("hex")}`;
}

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit nonce recommended for GCM
const TAG_LEN = 16;
const KEY_LEN = 32;

/**
 * Derive a 32-byte AES key from the SIGNING_SECRET_KEY env value using a
 * deterministic SHA-256 hash (no salt needed; the key itself is the secret).
 */
function deriveKey(rawKey: string): Buffer {
  return createHash("sha256").update(rawKey, "utf8").digest();
}

/**
 * Encrypt `plaintext` with AES-256-GCM.
 * Stores iv + authTag + ciphertext as a single base64 string.
 */
export function encryptSigningSecret(plaintext: string, rawKey: string): string {
  const key = deriveKey(rawKey);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: [iv (12)] [tag (16)] [ciphertext]
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * Decrypt a value produced by `encryptSigningSecret`.
 * Returns null when the key is wrong or the ciphertext is malformed / tampered.
 */
export function decryptSigningSecret(encoded: string, rawKey: string): string | null {
  try {
    const key = deriveKey(rawKey);
    const buf = Buffer.from(encoded, "base64");
    if (buf.length < IV_LEN + TAG_LEN + 1) return null;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

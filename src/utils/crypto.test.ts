import { describe, it, expect } from "vitest";
import { hashFileResource, hashLinkResource } from "./crypto.js";

const BUF_HELLO = Buffer.from("hello world");
const BUF_HELLO2 = Buffer.from("hello world");

describe("hashFileResource (issue #12)", () => {
  it("returns a hex string of length 64", () => {
    const h = hashFileResource(BUF_HELLO, "My Title");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable — same input always yields same hash", () => {
    expect(hashFileResource(BUF_HELLO, "My Title")).toBe(hashFileResource(BUF_HELLO2, "My Title"));
  });

  it("changes when file bytes change", () => {
    expect(hashFileResource(Buffer.from("a"), "Same Title")).not.toBe(
      hashFileResource(Buffer.from("b"), "Same Title"),
    );
  });

  it("changes when title changes (same bytes)", () => {
    expect(hashFileResource(BUF_HELLO, "Title A")).not.toBe(hashFileResource(BUF_HELLO, "Title B"));
  });

  it("handles an empty buffer", () => {
    const h = hashFileResource(Buffer.alloc(0), "Empty File");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashLinkResource (issue #13)", () => {
  const url = "https://example.com/path";
  const title = "Example Page";

  it("returns a hex string of length 64", () => {
    expect(hashLinkResource(url, title)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable — same URL and title always yield same hash", () => {
    expect(hashLinkResource(url, title)).toBe(hashLinkResource(url, title));
  });

  it("normalizes trailing slash on pathname", () => {
    expect(hashLinkResource("https://example.com/path/", title)).toBe(
      hashLinkResource("https://example.com/path", title),
    );
  });

  it("normalizes hostname to lowercase", () => {
    expect(hashLinkResource("https://EXAMPLE.COM/path", title)).toBe(
      hashLinkResource("https://example.com/path", title),
    );
  });

  it("normalizes query parameter order", () => {
    expect(hashLinkResource("https://example.com/?b=2&a=1", title)).toBe(
      hashLinkResource("https://example.com/?a=1&b=2", title),
    );
  });

  it("changes when URL changes", () => {
    expect(hashLinkResource("https://a.com", title)).not.toBe(
      hashLinkResource("https://b.com", title),
    );
  });

  it("changes when title changes", () => {
    expect(hashLinkResource(url, "Title A")).not.toBe(hashLinkResource(url, "Title B"));
  });
});

import {
  generateSigningSecret,
  encryptSigningSecret,
  decryptSigningSecret,
} from "./crypto.js";

describe("signing secret helpers (#42)", () => {
  const KEY = "test-encryption-key-32bytes-long!!";

  it("generateSigningSecret returns a svs_ prefixed hex string", () => {
    const s = generateSigningSecret();
    expect(s).toMatch(/^svs_[0-9a-f]{64}$/);
  });

  it("each call returns a unique secret", () => {
    expect(generateSigningSecret()).not.toBe(generateSigningSecret());
  });

  it("encrypt then decrypt round-trips correctly", () => {
    const plain = generateSigningSecret();
    const enc = encryptSigningSecret(plain, KEY);
    expect(enc).not.toBe(plain);
    expect(decryptSigningSecret(enc, KEY)).toBe(plain);
  });

  it("decryptSigningSecret returns null for wrong key", () => {
    const enc = encryptSigningSecret("svs_secret", KEY);
    expect(decryptSigningSecret(enc, "wrong-key-that-is-at-least-16chars")).toBeNull();
  });

  it("decryptSigningSecret returns null for tampered ciphertext", () => {
    const enc = encryptSigningSecret("svs_secret", KEY);
    const tampered = Buffer.from(enc, "base64");
    tampered[tampered.length - 1] ^= 0xff;
    expect(decryptSigningSecret(tampered.toString("base64"), KEY)).toBeNull();
  });

  it("ciphertext changes each call (different IV)", () => {
    const enc1 = encryptSigningSecret("svs_secret", KEY);
    const enc2 = encryptSigningSecret("svs_secret", KEY);
    expect(enc1).not.toBe(enc2);
  });
});

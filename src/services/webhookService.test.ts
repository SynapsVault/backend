import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

const { mockRows, logger } = vi.hoisted(() => ({
  mockRows: { value: [] as unknown[] },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../config.js", () => ({
  config: { NODE_ENV: "production", WEBHOOK_TIMEOUT_MS: 5_000, WEBHOOK_MAX_ATTEMPTS: 3 },
}));

vi.mock("../lib/logger.js", () => ({ getLogger: () => logger }));

vi.mock("../db/schema.js", () => ({ publishers: {}, webhookOutbox: {} }));

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(mockRows.value) }) }),
    }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "out-1" }]) }) }),
  },
}));

// Mock DNS so deliver() doesn't block on real network lookups in tests.
// Returns a non-private public IP for any hostname.
vi.mock("node:dns", () => ({
  promises: {
    lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
  },
}));

import { deliver, emitToPublisher, signPayload, webhookUrlProblem, isPrivateIp, resolveHostname, SIGNATURE_HEADER, DELIVERY_ID_HEADER } from "./webhookService.js";

function publisherRow(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/webhook",
    secret: "super-secret-value-123",
    events: ["resource.purchased"],
    enabled: true,
    ...overrides,
  };
}

const ok = () => ({ ok: true, status: 200 });

describe("webhookService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockRows.value = [publisherRow()];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("target resolution", () => {
    it("delivers to the publisher's configured URL", async () => {
      fetchMock.mockResolvedValue(ok());
      const result = await emitToPublisher("pub-1", "resource.purchased", { id: "r1" });
      expect(result).toMatchObject({ delivered: true, attempts: 1 });
      expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/webhook");
    });

    it("skips publishers without a webhook URL", async () => {
      mockRows.value = [publisherRow({ url: null })];
      expect(await emitToPublisher("pub-1", "resource.purchased", {})).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips publishers with webhooks disabled", async () => {
      mockRows.value = [publisherRow({ enabled: false })];
      expect(await emitToPublisher("pub-1", "resource.purchased", {})).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips unknown publishers", async () => {
      mockRows.value = [];
      expect(await emitToPublisher("missing", "resource.purchased", {})).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("event filtering", () => {
    it("skips events the publisher is not subscribed to", async () => {
      expect(await emitToPublisher("pub-1", "resource.delisted", {})).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([[[]], [null]])("delivers every event when the subscription list is %j", async (events) => {
      mockRows.value = [publisherRow({ events })];
      fetchMock.mockResolvedValue(ok());
      await emitToPublisher("pub-1", "resource.delisted", {});
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe("signing", () => {
    it("signs ${timestamp}.${body} with HMAC-SHA256 so the timestamp is covered (#45)", async () => {
      fetchMock.mockResolvedValue(ok());
      await emitToPublisher("pub-1", "resource.purchased", { id: "r1" });

      const [, init] = fetchMock.mock.calls[0];
      const ts = init.headers["X-SynapsVault-Timestamp"] as string;
      // #45: the HMAC input is "${timestamp}.${body}", not just the body.
      const expected = createHmac("sha256", "super-secret-value-123").update(`${ts}.${init.body}`).digest("hex");
      expect(init.headers[SIGNATURE_HEADER]).toBe(expected);
      expect(signPayload(init.body, "super-secret-value-123", ts)).toBe(expected);
    });

    it("signature changes when the timestamp changes (#45)", async () => {
      const body = JSON.stringify({ event: "resource.purchased", timestamp: "t1", data: {} });
      const sig1 = signPayload(body, "secret", "ts-1");
      const sig2 = signPayload(body, "secret", "ts-2");
      expect(sig1).not.toBe(sig2);
    });

    it("sends the event type and payload", async () => {
      fetchMock.mockResolvedValue(ok());
      await emitToPublisher("pub-1", "resource.purchased", { id: "r1" });

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({ event: "resource.purchased", data: { id: "r1" } });
      expect(init.headers["X-SynapsVault-Event"]).toBe("resource.purchased");
    });

    it("includes a stable X-SynapsVault-Id delivery header (#45)", async () => {
      fetchMock.mockResolvedValue(ok());
      await emitToPublisher("pub-1", "resource.purchased", { id: "r1" });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers[DELIVERY_ID_HEADER]).toMatch(/^wh_[0-9a-f]{32}$/);
    });

    it("omits the signature when no secret is configured", async () => {
      mockRows.value = [publisherRow({ secret: null })];
      fetchMock.mockResolvedValue(ok());
      await emitToPublisher("pub-1", "resource.purchased", {});
      expect(fetchMock.mock.calls[0][1].headers[SIGNATURE_HEADER]).toBeUndefined();
    });
  });

  describe("retries", () => {
    const target = { url: "https://example.com/hook" };
    const payload = { event: "resource.purchased" as const, timestamp: "t", data: {} };

    it("retries network errors and non-2xx responses, then succeeds", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce(ok());

      const promise = deliver(target, payload);
      await vi.runAllTimersAsync();
      expect(await promise).toMatchObject({ delivered: true, attempts: 3 });
    });

    it("gives up after WEBHOOK_MAX_ATTEMPTS and reports the failure", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue({ ok: false, status: 503 });

      const promise = deliver(target, payload);
      await vi.runAllTimersAsync();
      expect(await promise).toEqual({ delivered: false, attempts: 3, status: 503, error: "HTTP 503" });
      expect(logger.error).toHaveBeenCalled();
    });

    it("backs off exponentially between attempts", async () => {
      vi.useFakeTimers();
      fetchMock.mockRejectedValue(new Error("down"));

      const promise = deliver(target, payload);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await promise;
    });

    it("never throws from emitToPublisher", async () => {
      vi.useFakeTimers();
      fetchMock.mockRejectedValue(new Error("down"));
      const promise = emitToPublisher("pub-1", "resource.purchased", {});
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toMatchObject({ delivered: false });
    });
  });

  describe("webhookUrlProblem", () => {
    it("accepts public https URLs", () => {
      expect(webhookUrlProblem("https://hooks.example.com/synapsvault")).toBeNull();
    });

    it.each([
      "http://hooks.example.com/x",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://192.168.1.1/x",
      "https://172.20.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://metadata.internal/x",
      "not a url",
    ])("rejects %s", (url) => {
      expect(webhookUrlProblem(url)).not.toBeNull();
    });
  });

  describe("SSRF guard — DNS resolution at delivery time (#46)", () => {
    it("blocks a hostname that resolves to a private IP (10.x)", async () => {
      const { promises: dnsMock } = await import("node:dns");
      (dnsMock.lookup as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { address: "10.0.0.1", family: 4 },
      ]);
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await deliver(
        { url: "https://evil.example.com/hook" },
        { event: "resource.purchased", timestamp: "t", data: {} },
      );

      expect(result.delivered).toBe(false);
      expect(result.error).toMatch(/SSRF guard/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks the AWS metadata endpoint (169.254.169.254)", async () => {
      const { promises: dnsMock } = await import("node:dns");
      (dnsMock.lookup as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { address: "169.254.169.254", family: 4 },
      ]);
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await deliver(
        { url: "https://metadata.example.com/hook" },
        { event: "resource.purchased", timestamp: "t", data: {} },
      );

      expect(result.delivered).toBe(false);
      expect(result.error).toMatch(/SSRF guard/i);
    });

    it("DNS rebinding: re-resolves on each attempt and blocks mid-flight", async () => {
      const { promises: dnsMock } = await import("node:dns");
      // First attempt: resolves to a public IP → fetch fails.
      // Second attempt: resolves to a private IP → blocked (DNS rebinding).
      (dnsMock.lookup as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
        .mockResolvedValueOnce([{ address: "192.168.1.1", family: 4 }]);

      vi.useFakeTimers();
      fetchMock.mockRejectedValueOnce(new Error("connection refused"));

      const promise = deliver(
        { url: "https://rebind.example.com/hook" },
        { event: "resource.purchased", timestamp: "t", data: {} },
        { maxAttempts: 3 },
      );
      await vi.runAllTimersAsync();
      const result = await promise;

      // First attempt used public IP (fetch threw) → retry
      // Second attempt resolved to private IP → SSRF blocked
      expect(result.delivered).toBe(false);
      expect(result.error).toMatch(/SSRF guard/i);
    });

    it("isPrivateIp correctly identifies private ranges", () => {
      expect(isPrivateIp("10.0.0.1")).toBe(true);
      expect(isPrivateIp("192.168.1.1")).toBe(true);
      expect(isPrivateIp("172.16.0.1")).toBe(true);
      expect(isPrivateIp("169.254.169.254")).toBe(true);
      expect(isPrivateIp("127.0.0.1")).toBe(true);
      expect(isPrivateIp("::1")).toBe(true);
      expect(isPrivateIp("fc00::1")).toBe(true);
      expect(isPrivateIp("fe80::1")).toBe(true);
      expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true); // IPv6-mapped private

      expect(isPrivateIp("8.8.8.8")).toBe(false);
      expect(isPrivateIp("93.184.216.34")).toBe(false);
      expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
    });
  });
});

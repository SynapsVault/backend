import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  select: vi.fn(), set: vi.fn(), checkpoint: vi.fn(),
  read: vi.fn(), write: vi.fn(), exists: vi.fn(), mkdir: vi.fn(), events: vi.fn(),
}));
vi.mock("node:fs", () => ({ readFileSync: m.read, writeFileSync: m.write, existsSync: m.exists, mkdirSync: m.mkdir }));
vi.mock("../config.js", () => ({ config: {
  REGISTRY_CONTRACT_ID: "test-contract", SOROBAN_RPC_URL: "https://rpc.example.com",
  LOG_LEVEL: "silent", NODE_ENV: "test",
} }));
vi.mock("../db/client.js", () => ({ db: {
  select: m.select,
  update: () => ({ set: m.set }),
  insert: () => ({ values: m.checkpoint }),
} }));
vi.mock("@stellar/stellar-sdk", () => ({ rpc: { Server: class { getEvents = m.events; } } }));
import { startEventListener, stopEventListener } from "./eventListener.js";

function selectRows(rows: unknown[]) {
  m.select.mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve(rows) }) });
}
function event(type: string, value: Record<string, unknown>, ledger = 10) {
  return { ledger, id: `event-${ledger}`, topic: [type, "res-1"], value };
}
async function start() {
  startEventListener();
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  m.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) });
  m.set.mockReturnValue({ where: () => Object.assign(Promise.resolve(), { returning: () => Promise.resolve([{ id: "res-1" }]) }) });
  m.checkpoint.mockReturnValue({ onConflictDoUpdate: () => Promise.resolve() });
  m.exists.mockReturnValue(true);
  m.read.mockReturnValue(JSON.stringify({ lastLedger: 5 }));
  m.events.mockResolvedValue({ events: [] });
});
afterEach(() => {
  stopEventListener();
  vi.useRealTimers();
});

describe("eventListener", () => {
  it("initializes an empty checkpoint without polling RPC", async () => {
    m.exists.mockReturnValue(false);
    await start();
    expect(m.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ lastLedger: 1 }));
    expect(m.events).not.toHaveBeenCalled();
  });
  it("prefers the persisted database checkpoint", async () => {
    selectRows([{ lastLedger: 42 }]);
    await start();
    expect(m.events).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 42 }));
  });
  it("falls back to the tracker file when the database read fails", async () => {
    m.select.mockImplementationOnce(() => { throw new Error("DB down"); });
    await start();
    expect(m.events).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 5 }));
  });
  it("leaves the checkpoint unchanged on an empty event list", async () => {
    await start();
    expect(m.checkpoint).not.toHaveBeenCalled();
    expect(m.write).not.toHaveBeenCalled();
  });
  it("updates an existing registration and saves the checkpoint", async () => {
    selectRows([]);
    selectRows([{ id: "res-1" }]);
    m.events.mockResolvedValue({ events: [event("register", { type: "string", value: "owner" }, 20)] });
    await start();
    expect(m.set).toHaveBeenCalledWith({ onchainStatus: "registered" });
    expect(m.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ lastLedger: 21 }));
  });
  it("does not update a missing registration", async () => {
    m.events.mockResolvedValue({ events: [event("register", { type: "string", value: "owner" })] });
    await start();
    expect(m.set).not.toHaveBeenCalled();
  });
  it("converts stroops to a USDC decimal price", async () => {
    m.events.mockResolvedValue({ events: [event("setprice", { type: "i128", value: "10000000" })] });
    await start();
    expect(m.set).toHaveBeenCalledWith({ price: "1" });
  });
  it("updates the owner on a transfer", async () => {
    m.events.mockResolvedValue({ events: [event("transfer", { type: "address", value: "GNEW" })] });
    await start();
    expect(m.set).toHaveBeenCalledWith({ walletAddress: "GNEW" });
  });
  it.each([true, false])("syncs listed=%s", async (listed) => {
    m.events.mockResolvedValue({ events: [event("setlisted", { type: "bool", value: String(listed) })] });
    await start();
    expect(m.set).toHaveBeenCalledWith({ listed });
  });
  it("syncs title and description metadata", async () => {
    m.events.mockResolvedValue({ events: [event("updmeta", { type: "string", value: JSON.stringify({ title: "New", description: "Updated" }) })] });
    await start();
    expect(m.set).toHaveBeenCalledWith({ title: "New", description: "Updated" });
  });
  it("skips unpersisted tags and unknown events", async () => {
    m.events.mockResolvedValue({ events: [event("settags", { type: "vec", vec: [] }), event("unknown", { type: "string" })] });
    await start();
    expect(m.set).not.toHaveBeenCalled();
  });
  it("keeps the checkpoint on RPC errors and polls again", async () => {
    m.events.mockRejectedValueOnce(new Error("RPC down"));
    await start();
    expect(m.checkpoint).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000);
    expect(m.events).toHaveBeenCalledTimes(2);
  });
  it("resets a corrupt fallback file to the initial checkpoint", async () => {
    m.read.mockReturnValue("not JSON");
    await start();
    expect(m.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ lastLedger: 1 }));
    expect(m.events).not.toHaveBeenCalled();
  });
  it("continues polling after a fallback file write fails", async () => {
    m.write.mockImplementation(() => { throw new Error("disk full"); });
    m.events.mockResolvedValue({ events: [event("unknown", { type: "string" })] });
    await start();
    await vi.advanceTimersByTimeAsync(30000);
    expect(m.events).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  select: vi.fn(), set: vi.fn(), returning: vi.fn(), remove: vi.fn(),
  exists: vi.fn(), register: vi.fn(), send: vi.fn(), poll: vi.fn(),
  deleteFile: vi.fn(), downloadFile: vi.fn(), uploadFile: vi.fn(),
}));
vi.mock("../db/client.js", () => ({ db: {
  select: m.select,
  update: () => ({ set: m.set }),
  delete: () => ({ where: m.remove }),
} }));
vi.mock("../services/registryClient.js", () => ({
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  registryKeypair: { publicKey: () => "GREGISTRY" },
  registryClient: { register: m.register },
  resourceExists: m.exists,
  pollTransactionStatus: m.poll,
}));
vi.mock("../storage/supabaseStorage.js", () => ({
  deleteFile: m.deleteFile, downloadFile: m.downloadFile, uploadFile: m.uploadFile,
}));
import { startRetryPendingWorker, stopRetryPendingWorker } from "./retryPendingWorker.js";

function batch(registrations: unknown[] = [], cleanup: unknown[] = [], thumbnails: unknown[] = []) {
  for (const rows of [registrations, cleanup, thumbnails]) {
    const chain = { where: () => chain, orderBy: () => chain, limit: () => Promise.resolve(rows) };
    m.select.mockReturnValueOnce({ from: () => chain });
  }
}
const resource = { id: "res-1", walletAddress: "GREGISTRY", price: "1", title: "Test", contentHash: "hash", onchainTxHash: null };
async function start() {
  startRetryPendingWorker();
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  m.returning.mockResolvedValue([{ onchainAttempts: 1 }]);
  m.set.mockImplementation(() => ({ where: () => Object.assign(Promise.resolve(), { returning: m.returning }) }));
  m.exists.mockResolvedValue(false);
  m.register.mockResolvedValue({ signAndSend: m.send });
  m.send.mockResolvedValue({ sendTransactionResponse: { hash: "tx-hash" } });
});
afterEach(() => {
  stopRetryPendingWorker();
  vi.useRealTimers();
});

describe("retryPendingWorker", () => {
  it("drains all three queues when no registrations are stuck", async () => {
    batch();
    await start();
    expect(m.select).toHaveBeenCalledTimes(3);
    expect(m.register).not.toHaveBeenCalled();
  });
  it("marks an existing on-chain resource registered", async () => {
    batch([resource]);
    m.exists.mockResolvedValue(true);
    await start();
    expect(m.exists).toHaveBeenCalledWith(resource.id);
    expect(m.set).toHaveBeenCalledWith({ onchainStatus: "registered" });
    expect(m.register).not.toHaveBeenCalled();
  });
  it("registers for the server wallet and saves the transaction hash", async () => {
    batch([resource]);
    await start();
    expect(m.register).toHaveBeenCalledWith(expect.objectContaining({ id: resource.id, creator: "GREGISTRY", price: 10000000n }));
    expect(m.set).toHaveBeenCalledWith({ onchainStatus: "registered", onchainTxHash: "tx-hash" });
  });
  it("requires a client signature for another wallet", async () => {
    batch([{ ...resource, walletAddress: "GOTHER" }]);
    await start();
    expect(m.register).not.toHaveBeenCalled();
    expect(m.set).toHaveBeenCalledWith({ onchainStatus: "failed" });
  });
  it("leaves failed registration attempts retryable within the limit", async () => {
    batch([resource]);
    m.register.mockRejectedValue(new Error("RPC down"));
    await start();
    expect(m.set).not.toHaveBeenCalledWith({ onchainStatus: "failed" });
    expect(m.select).toHaveBeenCalledTimes(3);
  });
  it("stops registration after persisted attempts exceed the limit", async () => {
    batch([resource]);
    m.returning.mockResolvedValue([{ onchainAttempts: 4 }]);
    await start();
    expect(m.exists).not.toHaveBeenCalled();
    expect(m.set).toHaveBeenCalledWith({ onchainStatus: "failed" });
  });
  it.each(["SUCCESS", "FAILED", "PENDING"])("polls a stored transaction in state %s without resubmitting", async (status) => {
    batch([{ ...resource, onchainTxHash: "stored-hash" }]);
    m.poll.mockResolvedValue({ status });
    await start();
    expect(m.poll).toHaveBeenCalledWith("stored-hash", { maxAttempts: 1, intervalMs: 0 });
    expect(m.register).not.toHaveBeenCalled();
    if (status === "PENDING") expect(m.set).toHaveBeenCalledTimes(1);
    else expect(m.set).toHaveBeenCalledWith({ onchainStatus: status === "SUCCESS" ? "registered" : "failed" });
  });
  it("continues cleanup after the registration query fails", async () => {
    batch([], [{ id: "job", storagePath: "object", attempts: 0 }]);
    m.select.mockImplementationOnce(() => { throw new Error("DB down"); });
    await start();
    expect(m.deleteFile).toHaveBeenCalledWith("object");
    expect(m.remove).toHaveBeenCalled();
  });
  it("persists cleanup retry attempts", async () => {
    batch([], [{ id: "job", storagePath: "object", attempts: 1 }]);
    m.deleteFile.mockRejectedValue(new Error("storage down"));
    await start();
    expect(m.set).toHaveBeenCalledWith({ attempts: 2 });
    expect(m.remove).not.toHaveBeenCalled();
  });
  it("stops scheduling work after stop", async () => {
    batch();
    await start();
    stopRetryPendingWorker();
    await vi.advanceTimersByTimeAsync(180000);
    expect(m.select).toHaveBeenCalledTimes(3);
  });
});

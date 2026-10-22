import { sql } from "drizzle-orm";
import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import { db } from "../db/client.js";
import { config } from "../config.js";
import { createTtlCache } from "./ttlCache.js";

export type DependencyStatus = "ok" | "error";

export interface DependencyCheck {
  status: DependencyStatus;
  latencyMs: number;
  error?: string;
  details?: Record<string, unknown>;
}

const PROBE_TIMEOUT_MS =
  (config as { READINESS_PROBE_TIMEOUT_MS?: number }).READINESS_PROBE_TIMEOUT_MS ??
  (config as { REQUEST_TIMEOUT_MS?: number }).REQUEST_TIMEOUT_MS ??
  2000;

const PROBE_CACHE_TTL_MS =
  (config as { READINESS_PROBE_CACHE_TTL_MS?: number }).READINESS_PROBE_CACHE_TTL_MS ??
  3000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function runDatabaseProbe(): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    await withTimeout(
      Promise.resolve(db.execute(sql`SELECT 1`)),
      PROBE_TIMEOUT_MS,
      "Database probe",
    );
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Database probe failed",
    };
  }
}

async function runSorobanRpcProbe(): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    const rpcServer = new StellarRpc.Server(config.SOROBAN_RPC_URL);
    const health = await withTimeout(
      rpcServer.getHealth(),
      PROBE_TIMEOUT_MS,
      "Soroban RPC probe",
    );
    return {
      status: "ok",
      latencyMs: Date.now() - start,
      details: {
        latestLedger: health.latestLedger,
        oldestLedger: health.oldestLedger,
        ledgerRetentionWindow: health.ledgerRetentionWindow,
      },
    };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Soroban RPC probe failed",
    };
  }
}

// Probe results are cached briefly so frequent readiness polls don't hammer
// the database and RPC; concurrent callers share one in-flight probe.
const probeCache = createTtlCache<DependencyCheck>({ defaultTtlMs: PROBE_CACHE_TTL_MS });
const inFlightProbes = new Map<string, Promise<DependencyCheck>>();

function cachedProbe(key: string, run: () => Promise<DependencyCheck>): Promise<DependencyCheck> {
  const cached = probeCache.get(key);
  if (cached) return Promise.resolve(cached);
  let pending = inFlightProbes.get(key);
  if (!pending) {
    pending = run()
      .then((result) => {
        probeCache.set(key, result);
        return result;
      })
      .finally(() => inFlightProbes.delete(key));
    inFlightProbes.set(key, pending);
  }
  return pending;
}

export async function probeDatabase(): Promise<DependencyCheck> {
  return cachedProbe("database", runDatabaseProbe);
}

export async function probeSorobanRpc(): Promise<DependencyCheck> {
  return cachedProbe("sorobanRpc", runSorobanRpcProbe);
}

/** All readiness dependency checks, keyed by dependency name. */
export async function getCachedProbes(): Promise<Record<string, DependencyCheck>> {
  const [database, sorobanRpc] = await Promise.all([probeDatabase(), probeSorobanRpc()]);
  return { database, sorobanRpc };
}
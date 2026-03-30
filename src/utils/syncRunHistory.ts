import * as fs from "fs/promises";
import * as path from "path";
import type { SyncTarget } from "../config";
import type { StockSyncResult } from "../jobs/stockSync";
import { logger } from "./logger";
import { shouldUseNetlifyBlobs } from "./storageBackend";

/** Plafond d’enregistrements persistés (cron ~144/jour/cible ; marge pour digest + manuels). */
export const SYNC_RUN_HISTORY_CAP = 500;
const MAX_RUNS = SYNC_RUN_HISTORY_CAP;
const BLOB_STORE = "aperol-sync-runs";
const BLOB_KEY = "runs";

export interface SyncRunPart {
  ok: boolean;
  error?: string;
  success: number;
  failed: number;
  detail: unknown;
}

export interface SyncRunRecord {
  id: string;
  at: string;
  target: SyncTarget;
  kind: "sync-uk" | "stock";
  durationSec: number;
  stock: SyncRunPart;
  /** Anciens runs (sync expéditions supprimée) — conservé pour lecture seule. */
  shipments?: SyncRunPart;
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function buildStockPartFromResult(
  res: PromiseSettledResult<StockSyncResult>,
): SyncRunPart {
  if (res.status === "rejected") {
    const err = String(res.reason);
    return {
      ok: false,
      error: err,
      success: 0,
      failed: 1,
      detail: { error: err },
    };
  }
  const v = res.value;
  const failed = v.userErrors + v.skippedMissingItemId;
  return {
    ok: failed === 0,
    success: v.appliedItems,
    failed,
    detail: cloneJson(v),
  };
}

export function buildSyncUkRunRecord(
  target: SyncTarget,
  runId: string,
  durationSec: number,
  stockRes: PromiseSettledResult<StockSyncResult>,
): SyncRunRecord {
  return {
    id: runId,
    at: new Date().toISOString(),
    target,
    kind: "sync-uk",
    durationSec,
    stock: buildStockPartFromResult(stockRes),
  };
}

export function buildStockOnlyRunRecord(
  target: SyncTarget,
  runId: string,
  durationSec: number,
  stock: StockSyncResult,
): SyncRunRecord {
  const failed = stock.userErrors + stock.skippedMissingItemId;
  return {
    id: runId,
    at: new Date().toISOString(),
    target,
    kind: "stock",
    durationSec,
    stock: {
      ok: failed === 0,
      success: stock.appliedItems,
      failed,
      detail: cloneJson(stock),
    },
  };
}

function useBlobStorage(): boolean {
  return shouldUseNetlifyBlobs("SYNC_RUN_HISTORY_PATH");
}

async function readRunsFromBlob(): Promise<SyncRunRecord[] | null> {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore(BLOB_STORE);
    const raw = await store.get(BLOB_KEY, { type: "json" });
    if (raw == null) return [];
    return Array.isArray(raw) ? (raw as SyncRunRecord[]) : [];
  } catch {
    return null;
  }
}

async function writeRunsToBlob(runs: SyncRunRecord[]): Promise<void> {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore(BLOB_STORE);
  await store.setJSON(BLOB_KEY, runs);
}

function resolveFilePath(): string {
  const fromEnv = process.env.SYNC_RUN_HISTORY_PATH;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(process.cwd(), "data", "sync-runs.json");
}

async function readRunsFromFile(): Promise<SyncRunRecord[]> {
  const fp = resolveFilePath();
  try {
    const raw = await fs.readFile(fp, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SyncRunRecord[]) : [];
  } catch (e: unknown) {
    const code = e && typeof e === "object" && "code" in e ? (e as NodeJS.ErrnoException).code : "";
    if (code === "ENOENT") return [];
    throw e;
  }
}

async function writeRunsToFile(runs: SyncRunRecord[]): Promise<void> {
  const fp = resolveFilePath();
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(runs, null, 2), "utf8");
}

async function loadRuns(): Promise<SyncRunRecord[]> {
  if (useBlobStorage()) {
    const fromBlob = await readRunsFromBlob();
    if (fromBlob !== null) return fromBlob;
  }
  return readRunsFromFile();
}

async function saveRuns(runs: SyncRunRecord[]): Promise<void> {
  if (useBlobStorage()) {
    await writeRunsToBlob(runs);
  } else {
    await writeRunsToFile(runs);
  }
}

export async function appendSyncRun(record: SyncRunRecord): Promise<void> {
  try {
    const runs = await loadRuns();
    const next = [record, ...runs].slice(0, MAX_RUNS);
    await saveRuns(next);
    logger.info("sync_run_recorded", {
      id: record.id,
      kind: record.kind,
      target: record.target,
      stockOk: record.stock.ok,
      stockS: record.stock.success,
      stockF: record.stock.failed,
    });
  } catch (err) {
    logger.error("sync_run_history_append_failed", { error: String(err) });
  }
}

export async function listSyncRuns(options: {
  limit?: number;
  target?: SyncTarget | "all";
}): Promise<SyncRunRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 80, 1), MAX_RUNS);
  let runs = await loadRuns();
  const t = options.target ?? "all";
  if (t !== "all") {
    runs = runs.filter((r) => r.target === t);
  }
  return runs.slice(0, limit);
}

export async function deleteSyncRun(id: string): Promise<boolean> {
  const runs = await loadRuns();
  const filtered = runs.filter((r) => r.id !== id);
  if (filtered.length === runs.length) return false;
  await saveRuns(filtered);
  return true;
}

/** Snapshot complet de l’historique tel que stocké (jusqu’à MAX_RUNS entrées). */
export async function loadSyncHistorySnapshot(): Promise<SyncRunRecord[]> {
  return loadRuns();
}

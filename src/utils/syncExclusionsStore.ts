import * as fs from "fs/promises";
import * as path from "path";
import type { SyncTarget } from "../config";
import { normalizeSku } from "./skuNormalize";
import { logger } from "./logger";
import { shouldUseNetlifyBlobs } from "./storageBackend";

const BLOB_STORE = "aperol-sync-exclusions";
const BLOB_KEY = "v1";

export interface SyncExclusionsPersisted {
  prod: string[];
  staging: string[];
  updatedAt: string;
}

function useBlobStorage(): boolean {
  return shouldUseNetlifyBlobs("SYNC_EXCLUSIONS_SETTINGS_PATH");
}

function defaultPersisted(): SyncExclusionsPersisted {
  return {
    prod: [],
    staging: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeSkuList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const sku = normalizeSku(String(raw ?? ""));
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    out.push(sku);
  }
  return out;
}

function normalizePersisted(o: Record<string, unknown>): SyncExclusionsPersisted | null {
  if (typeof o !== "object" || o === null) return null;
  return {
    prod: normalizeSkuList(o.prod),
    staging: normalizeSkuList(o.staging),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : new Date().toISOString(),
  };
}

async function readFromBlob(): Promise<SyncExclusionsPersisted | null> {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore(BLOB_STORE);
    const raw = await store.get(BLOB_KEY, { type: "json" });
    if (raw == null || typeof raw !== "object") return null;
    return normalizePersisted(raw as Record<string, unknown>);
  } catch {
    return null;
  }
}

async function writeToBlob(data: SyncExclusionsPersisted): Promise<void> {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore(BLOB_STORE);
  await store.setJSON(BLOB_KEY, data);
}

function resolveFilePath(): string {
  const fromEnv = process.env.SYNC_EXCLUSIONS_SETTINGS_PATH;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(process.cwd(), "data", "sync-exclusions.json");
}

async function readFromFile(): Promise<SyncExclusionsPersisted | null> {
  const fp = resolveFilePath();
  try {
    const raw = await fs.readFile(fp, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return normalizePersisted(parsed as Record<string, unknown>);
  } catch (e: unknown) {
    const code = e && typeof e === "object" && "code" in e ? (e as NodeJS.ErrnoException).code : "";
    if (code === "ENOENT") return null;
    throw e;
  }
}

async function writeToFile(data: SyncExclusionsPersisted): Promise<void> {
  const fp = resolveFilePath();
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(data, null, 2), "utf8");
}

export async function loadSyncExclusions(): Promise<SyncExclusionsPersisted> {
  if (useBlobStorage()) {
    const fromBlob = await readFromBlob();
    if (fromBlob !== null) return fromBlob;
  }
  try {
    const fromFile = await readFromFile();
    if (fromFile !== null) return fromFile;
  } catch (err) {
    logger.warn("sync_exclusions_read_failed", { error: String(err) });
  }
  return defaultPersisted();
}

export async function saveSyncExclusions(data: SyncExclusionsPersisted): Promise<void> {
  const next: SyncExclusionsPersisted = {
    prod: normalizeSkuList(data.prod),
    staging: normalizeSkuList(data.staging),
    updatedAt: new Date().toISOString(),
  };
  if (useBlobStorage()) {
    await writeToBlob(next);
  } else {
    await writeToFile(next);
  }
  logger.info("sync_exclusions_saved", {
    prodCount: next.prod.length,
    stagingCount: next.staging.length,
    at: next.updatedAt,
  });
}

export async function loadSyncExclusionsSetForTarget(target: SyncTarget): Promise<Set<string>> {
  const stored = await loadSyncExclusions();
  return new Set(target === "staging" ? stored.staging : stored.prod);
}


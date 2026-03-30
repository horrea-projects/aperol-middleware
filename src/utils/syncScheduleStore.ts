import * as fs from "fs/promises";
import * as path from "path";
import type { SyncTarget } from "../config";
import { logger } from "./logger";
import { shouldUseNetlifyBlobs } from "./storageBackend";

const BLOB_STORE = "aperol-sync-schedule";
const BLOB_KEY = "v1";

export const SYNC_SCHEDULE_MIN_MINUTES = 5;
export const SYNC_SCHEDULE_MAX_MINUTES = 10_080; // 7 jours
export const SYNC_SCHEDULE_DEFAULT_INTERVAL_MINUTES = 120;

export interface SyncScheduleTimerState {
  prod: string | null;
  staging: string | null;
}

export interface SyncSchedulePersisted {
  prodEnabled: boolean;
  stagingEnabled: boolean;
  prodIntervalMinutes: number;
  stagingIntervalMinutes: number;
  lastRun: SyncScheduleTimerState;
  updatedAt: string;
}

function useBlobStorage(): boolean {
  return shouldUseNetlifyBlobs("SYNC_SCHEDULE_SETTINGS_PATH");
}

function defaultPersisted(): SyncSchedulePersisted {
  const now = new Date().toISOString();
  return {
    prodEnabled: true,
    stagingEnabled: true,
    prodIntervalMinutes: SYNC_SCHEDULE_DEFAULT_INTERVAL_MINUTES,
    stagingIntervalMinutes: SYNC_SCHEDULE_DEFAULT_INTERVAL_MINUTES,
    lastRun: { prod: null, staging: null },
    updatedAt: now,
  };
}

function clampInterval(m: number): number {
  if (!Number.isFinite(m)) return SYNC_SCHEDULE_DEFAULT_INTERVAL_MINUTES;
  const i = Math.floor(m);
  return Math.min(SYNC_SCHEDULE_MAX_MINUTES, Math.max(SYNC_SCHEDULE_MIN_MINUTES, i));
}

function normalizePersisted(o: Record<string, unknown>): SyncSchedulePersisted | null {
  if (typeof o !== "object" || o === null) return null;
  const lr = o.lastRun;
  const lastRun: SyncScheduleTimerState =
    lr && typeof lr === "object" && lr !== null
      ? {
          prod: typeof (lr as { prod?: unknown }).prod === "string" ? (lr as { prod: string }).prod : null,
          staging:
            typeof (lr as { staging?: unknown }).staging === "string"
              ? (lr as { staging: string }).staging
              : null,
        }
      : { prod: null, staging: null };
  return {
    prodEnabled: Boolean(o.prodEnabled),
    stagingEnabled: Boolean(o.stagingEnabled),
    prodIntervalMinutes: clampInterval(Number(o.prodIntervalMinutes)),
    stagingIntervalMinutes: clampInterval(Number(o.stagingIntervalMinutes)),
    lastRun,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : new Date().toISOString(),
  };
}

async function readFromBlob(): Promise<SyncSchedulePersisted | null> {
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

async function writeToBlob(data: SyncSchedulePersisted): Promise<void> {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore(BLOB_STORE);
  await store.setJSON(BLOB_KEY, data);
}

function resolveFilePath(): string {
  const fromEnv = process.env.SYNC_SCHEDULE_SETTINGS_PATH;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(process.cwd(), "data", "sync-schedule.json");
}

async function readFromFile(): Promise<SyncSchedulePersisted | null> {
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

async function writeToFile(data: SyncSchedulePersisted): Promise<void> {
  const fp = resolveFilePath();
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(data, null, 2), "utf8");
}

export async function loadSyncSchedule(): Promise<SyncSchedulePersisted> {
  if (useBlobStorage()) {
    const fromBlob = await readFromBlob();
    if (fromBlob !== null) return fromBlob;
  }
  try {
    const fromFile = await readFromFile();
    if (fromFile !== null) return fromFile;
  } catch (err) {
    logger.warn("sync_schedule_read_failed", { error: String(err) });
  }
  return defaultPersisted();
}

async function writePersisted(data: SyncSchedulePersisted): Promise<void> {
  if (useBlobStorage()) {
    await writeToBlob(data);
  } else {
    await writeToFile(data);
  }
}

export async function saveSyncSchedule(data: SyncSchedulePersisted): Promise<void> {
  const next: SyncSchedulePersisted = {
    ...data,
    prodIntervalMinutes: clampInterval(data.prodIntervalMinutes),
    stagingIntervalMinutes: clampInterval(data.stagingIntervalMinutes),
    updatedAt: new Date().toISOString(),
  };
  await writePersisted(next);
  logger.info("sync_schedule_saved", { at: next.updatedAt });
}

/** À appeler au début d’une sync UK complète : alimente le minuteur côté cron (sans modifier `updatedAt` du dashboard). */
export async function touchSyncUkLastRun(target: SyncTarget): Promise<void> {
  const cur = await loadSyncSchedule();
  const at = new Date().toISOString();
  const lastRun =
    target === "prod"
      ? { ...cur.lastRun, prod: at }
      : { ...cur.lastRun, staging: at };
  const next: SyncSchedulePersisted = {
    ...cur,
    prodIntervalMinutes: clampInterval(cur.prodIntervalMinutes),
    stagingIntervalMinutes: clampInterval(cur.stagingIntervalMinutes),
    lastRun,
  };
  await writePersisted(next);
  logger.info("sync_uk_schedule_touch", { target, at });
}

export interface ScheduleGateResult {
  skip: boolean;
  reason?: "schedule_disabled" | "too_soon" | "not_applicable";
  waitMinutesApprox?: number;
}

export async function evaluateSyncUkScheduleGate(params: {
  target: SyncTarget;
  isScheduledInvocation: boolean;
}): Promise<ScheduleGateResult> {
  if (!params.isScheduledInvocation) {
    return { skip: false, reason: "not_applicable" };
  }
  const s = await loadSyncSchedule();
  const enabled = params.target === "prod" ? s.prodEnabled : s.stagingEnabled;
  if (!enabled) {
    return { skip: true, reason: "schedule_disabled" };
  }
  const interval = params.target === "prod" ? s.prodIntervalMinutes : s.stagingIntervalMinutes;
  const lastIso = params.target === "prod" ? s.lastRun.prod : s.lastRun.staging;
  if (!lastIso) {
    return { skip: false };
  }
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) {
    return { skip: false };
  }
  const minMs = interval * 60 * 1000;
  const elapsed = Date.now() - last;
  if (elapsed < minMs) {
    return {
      skip: true,
      reason: "too_soon",
      waitMinutesApprox: Math.max(1, Math.ceil((minMs - elapsed) / 60_000)),
    };
  }
  return { skip: false };
}

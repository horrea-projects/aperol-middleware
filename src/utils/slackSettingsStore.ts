import * as fs from "fs/promises";
import * as path from "path";
import type { SyncTarget } from "../config";
import { logger } from "./logger";
import { shouldUseNetlifyBlobs } from "./storageBackend";

const BLOB_STORE = "aperol-slack-settings";
const BLOB_KEY = "v1";

/** Sous-réglages Slack pour un environnement (prod ou staging). */
export interface SlackTargetSettingsPersisted {
  notificationsEnabled: boolean;
  perRunReportsEnabled: boolean;
  dailyDigestEnabled: boolean;
}

/** Réglages Slack pilotés par le dashboard (priorité sur les variables d’environnement pour cette instance). */
export interface SlackSettingsPersisted {
  overridesActive: boolean;
  prod: SlackTargetSettingsPersisted;
  staging: SlackTargetSettingsPersisted;
  updatedAt: string;
}

function useBlobStorage(): boolean {
  return shouldUseNetlifyBlobs("SLACK_SETTINGS_PATH");
}

async function readFromBlob(): Promise<SlackSettingsPersisted | null> {
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

async function writeToBlob(data: SlackSettingsPersisted): Promise<void> {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore(BLOB_STORE);
  await store.setJSON(BLOB_KEY, data);
}

function resolveFilePath(): string {
  const fromEnv = process.env.SLACK_SETTINGS_PATH;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(process.cwd(), "data", "slack-settings.json");
}

async function readFromFile(): Promise<SlackSettingsPersisted | null> {
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

async function writeToFile(data: SlackSettingsPersisted): Promise<void> {
  const fp = resolveFilePath();
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(data, null, 2), "utf8");
}

function normalizeTargetBlock(o: unknown): SlackTargetSettingsPersisted | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  return {
    notificationsEnabled: Boolean(r.notificationsEnabled),
    perRunReportsEnabled: Boolean(r.perRunReportsEnabled),
    dailyDigestEnabled: Boolean(r.dailyDigestEnabled),
  };
}

function normalizePersisted(o: Record<string, unknown>): SlackSettingsPersisted | null {
  if (typeof o.overridesActive !== "boolean") return null;

  const prodNew = normalizeTargetBlock(o.prod);
  const stagingNew = normalizeTargetBlock(o.staging);
  if (prodNew && stagingNew) {
    return {
      overridesActive: o.overridesActive,
      prod: prodNew,
      staging: stagingNew,
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : new Date().toISOString(),
    };
  }

  // Ancien format plat (même politique prod + staging)
  if ("notificationsEnabled" in o) {
    const t: SlackTargetSettingsPersisted = {
      notificationsEnabled: Boolean(o.notificationsEnabled),
      perRunReportsEnabled: Boolean(o.perRunReportsEnabled),
      dailyDigestEnabled: Boolean(o.dailyDigestEnabled),
    };
    return {
      overridesActive: o.overridesActive,
      prod: { ...t },
      staging: { ...t },
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : new Date().toISOString(),
    };
  }

  return null;
}

export async function loadSlackSettings(): Promise<SlackSettingsPersisted | null> {
  if (useBlobStorage()) {
    const fromBlob = await readFromBlob();
    if (fromBlob !== null) return fromBlob;
  }
  try {
    return await readFromFile();
  } catch (err) {
    logger.warn("slack_settings_read_failed", { error: String(err) });
    return null;
  }
}

export async function saveSlackSettings(data: SlackSettingsPersisted): Promise<void> {
  if (useBlobStorage()) {
    await writeToBlob(data);
  } else {
    await writeToFile(data);
  }
  logger.info("slack_settings_saved", {
    overridesActive: data.overridesActive,
    at: data.updatedAt,
  });
}

export function pickTargetSettings(
  s: SlackSettingsPersisted,
  target: SyncTarget,
): SlackTargetSettingsPersisted {
  return target === "staging" ? s.staging : s.prod;
}

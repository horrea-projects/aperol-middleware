import { getConfig, getProdConfig } from "../config";

function fileLogPath(): string {
  try {
    return getConfig().fileLog.logPath;
  } catch {
    return getProdConfig().fileLog.logPath;
  }
}

export function fileLoggingEnabled(): boolean {
  return Boolean(fileLogPath());
}

export async function appendFileLogEntry(entry: Record<string, unknown>): Promise<void> {
  const logPath = fileLogPath();
  if (!logPath) return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = path.dirname(logPath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore
  }
  await fs.appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
}

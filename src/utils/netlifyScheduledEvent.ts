import type { HandlerEvent } from "@netlify/functions";

function header(event: HandlerEvent, name: string): string {
  const h = event.headers ?? {};
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower && v != null) return String(v);
  }
  return "";
}

/**
 * Indique un déclenchement par le scheduler Netlify (cron ou « Run now » dans l’UI Functions).
 * Les invocations locales (`netlify functions:invoke`) n’ont en général ni `next_run` ni ces en-têtes → pas de garde temporelle.
 */
export function isNetlifyScheduledSyncInvocation(event: HandlerEvent): boolean {
  if (header(event, "x-nf-event").toLowerCase() === "schedule") return true;
  if (header(event, "x-netlify-event").toLowerCase() === "schedule") return true;
  const ua = header(event, "user-agent").toLowerCase();
  if (ua.includes("netlify") && ua.includes("clockwork")) return true;
  try {
    const raw = event.body;
    if (!raw || typeof raw !== "string") return false;
    const b = JSON.parse(raw) as { next_run?: unknown };
    return typeof b?.next_run === "string";
  } catch {
    return false;
  }
}

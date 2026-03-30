import { createHmac, timingSafeEqual } from "node:crypto";
import type { HandlerEvent, HandlerResponse } from "@netlify/functions";

const TOKEN_TTL_SEC = 7 * 24 * 3600;

/** Cookie HttpOnly : session dashboard (valeur signée côté serveur, pas le mot de passe). */
export const DASHBOARD_SESSION_COOKIE = "aperol_dash_sess";

/**
 * Netlify / copier-coller : BOM ou retour à la ligne final très fréquents sur
 * DASHBOARD_PASSWORD / DASHBOARD_AUTH_SECRET — sinon la session cookie est signée avec
 * une chaîne différente de celle utilisée à la vérification (échec après rechargement).
 */
export function normalizeDashboardSecret(value: string): string {
  return value.replace(/^\uFEFF/, "").trimEnd();
}

/** Secret de signature : préférer DASHBOARD_AUTH_SECRET en production ; sinon dérivé du mot de passe. */
function signingSecret(): string {
  const authRaw = process.env.DASHBOARD_AUTH_SECRET;
  const passRaw = process.env.DASHBOARD_PASSWORD ?? "";
  const raw =
    authRaw !== undefined && authRaw !== "" ? authRaw : passRaw;
  return normalizeDashboardSecret(raw);
}

export function isDashboardAuthConfigured(): boolean {
  return normalizeDashboardSecret(process.env.DASHBOARD_PASSWORD ?? "").length > 0;
}

/** Valeur à placer dans le cookie de session (signature + expiration). */
export function createDashboardSessionCookieValue(): string {
  const secret = signingSecret();
  if (!secret) throw new Error("DASHBOARD_PASSWORD ou DASHBOARD_AUTH_SECRET manquant");
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const sig = createHmac("sha256", secret).update(String(exp)).digest("hex");
  return `${exp}.${sig}`;
}

function isForwardedHttps(event: HandlerEvent): boolean {
  const proto = String(
    event.headers["x-forwarded-proto"] ||
      event.headers["X-Forwarded-Proto"] ||
      ""
  ).toLowerCase();
  return proto === "https";
}

export function dashboardSessionSetCookieHeader(
  event: HandlerEvent,
  sessionValue: string
): string {
  const secure = isForwardedHttps(event);
  const parts = [
    `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(sessionValue)}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${TOKEN_TTL_SEC}`,
    "SameSite=Lax"
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function dashboardSessionClearCookieHeader(event: HandlerEvent): string {
  const secure = isForwardedHttps(event);
  const parts = [
    `${DASHBOARD_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "SameSite=Lax"
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function dashboardAuthDebugEnabled(): boolean {
  const v = process.env.DASHBOARD_DEBUG;
  return v === "1" || v === "true";
}

export function readDashboardSessionCookie(event: HandlerEvent): string {
  const h = event.headers || {};
  const raw =
    h.cookie ||
    h.Cookie ||
    event.multiValueHeaders?.["Cookie"]?.[0] ||
    event.multiValueHeaders?.["cookie"]?.[0] ||
    "";
  if (!raw) return "";
  const prefix = DASHBOARD_SESSION_COOKIE + "=";
  for (const part of raw.split(";")) {
    const p = part.trim();
    if (!p.startsWith(prefix)) continue;
    const v = p.slice(prefix.length);
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return "";
}

export function verifyDashboardToken(token: string): boolean {
  const secret = signingSecret();
  if (!secret) return false;
  const parts = token.trim().split(".");
  if (parts.length !== 2) return false;
  const exp = parseInt(parts[0], 10);
  const sig = parts[1];
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac("sha256", secret).update(String(exp)).digest("hex");
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Si DASHBOARD_PASSWORD est défini, exige un cookie de session valide (sauf OPTIONS).
 * Réponse 401 avec effacement du cookie pour forcer une nouvelle connexion.
 */
export function guardDashboardAuth(
  event: HandlerEvent,
  corsHeaders: Record<string, string>
): HandlerResponse | null {
  if (!isDashboardAuthConfigured()) return null;
  if (event.httpMethod === "OPTIONS") return null;
  const session = readDashboardSessionCookie(event);
  const sessionOk = Boolean(session && verifyDashboardToken(session));

  if (dashboardAuthDebugEnabled()) {
    const ch = (event.headers?.cookie || event.headers?.Cookie || "") as string;
    console.warn("[dashboard-auth guard]", event.httpMethod, event.path || "", {
      cookieHeaderLength: ch.length,
      hasSessionCookieName: ch.includes(DASHBOARD_SESSION_COOKIE + "="),
      sessionValuePresent: Boolean(session),
      sessionOk
    });
  }

  if (!sessionOk) {
    return {
      statusCode: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      multiValueHeaders: {
        "Set-Cookie": [dashboardSessionClearCookieHeader(event)]
      },
      body: JSON.stringify({
        error: "dashboard_auth_required",
        message: "Mot de passe dashboard requis ou session expirée. Reconnectez-vous."
      })
    };
  }
  return null;
}

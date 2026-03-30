import type { Handler } from "@netlify/functions";
import { sendDailySlackDigestFromEnv } from "../../src/utils/dailySlackDigest";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

function header(
  event: Parameters<Handler>[0],
  name: string,
): string {
  const h = event.headers ?? {};
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower && v != null) return String(v);
  }
  return "";
}

function isAuthorized(event: Parameters<Handler>[0]): boolean {
  const secret = (process.env.DAILY_DIGEST_HTTP_SECRET ?? "").trim();
  if (!secret) return true;
  const auth = header(event, "authorization");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const fromHeader = header(event, "x-daily-digest-secret");
  return bearer === secret || fromHeader === secret;
}

/**
 * Même logique que `daily-slack-digest`, mais **sans** entrée planifiée :
 * appel HTTP (GET ou POST) pour test local, déclenchement à la main dans l’UI Netlify, ou Zapier / cron externe.
 * Si `DAILY_DIGEST_HTTP_SECRET` est défini, envoyer `Authorization: Bearer <secret>` ou `X-Daily-Digest-Secret: <secret>`.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...CORS, "Access-Control-Allow-Headers": "Authorization, X-Daily-Digest-Secret, Content-Type" }, body: "" };
  }
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  if (!isAuthorized(event)) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized — définir DAILY_DIGEST_HTTP_SECRET et l’entête correspondante" }) };
  }

  try {
    const r = await sendDailySlackDigestFromEnv();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(r) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: String(e) }) };
  }
};

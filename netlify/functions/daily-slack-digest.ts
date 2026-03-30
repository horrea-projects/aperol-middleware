import type { Handler } from "@netlify/functions";
import { sendDailySlackDigestFromEnv } from "../../src/utils/dailySlackDigest";

/**
 * Rapport Slack quotidien — **uniquement** invoquée par le scheduler Netlify (cron).
 * Pour un déclenchement manuel ou une URL : utiliser `daily-slack-digest-manual`.
 */
export const handler: Handler = async () => {
  try {
    const r = await sendDailySlackDigestFromEnv();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(e) }),
    };
  }
};

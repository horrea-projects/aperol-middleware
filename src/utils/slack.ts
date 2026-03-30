import "./loadEnvFile";
import { getConfig } from "../config";
import { httpRequest } from "./http";
import { logger } from "./logger";
import { resolveSlackPolicy } from "./slackPolicy";

/** Payload minimal pour un Incoming Webhook Slack (sans passer par `getConfig`). */
export type SlackIncomingPayload = {
  text: string;
  /** Blocs optionnels ; le webhook accepte `text` seul. */
  blocks?: unknown[];
};

export async function postSlackIncomingWebhook(
  webhookUrl: string,
  payload: SlackIncomingPayload,
): Promise<void> {
  const p = await resolveSlackPolicy();
  if (!p.notifications || !p.dailyDigest) return;
  if (!webhookUrl.trim()) return;
  try {
    await httpRequest(webhookUrl.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      retryCount: 2,
      retryDelayMs: 500,
    });
  } catch (err) {
    logger.warn("slack_incoming_webhook_failed", { error: String(err) });
    throw err;
  }
}

function slackEnabled(): boolean {
  try {
    return Boolean(getConfig().slack.webhookUrl);
  } catch {
    return false;
  }
}

export async function sendSlackRunReport(text: string, meta?: Record<string, unknown>): Promise<void> {
  const p = await resolveSlackPolicy();
  if (!p.notifications || !p.perRunReports) return;
  if (!slackEnabled()) return;

  const webhookUrl = getConfig().slack.webhookUrl;
  const payload: any = { text };

  if (meta && Object.keys(meta).length > 0) {
    payload.attachments = [
      {
        text: "```" + JSON.stringify(meta, null, 2).slice(0, 3500) + "```",
        mrkdwn_in: ["text"],
      },
    ];
  }

  try {
    await httpRequest(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: payload,
      retryCount: 2,
      retryDelayMs: 500,
    });
  } catch (err) {
    logger.warn("slack_send_failed", { error: String(err) });
  }
}

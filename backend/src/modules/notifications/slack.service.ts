import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

type SlackAlertType = "delivery_created" | "driver_assigned" | "delivery_status_updated";

export async function sendSlackAlertBestEffort(
  type: SlackAlertType,
  message: string,
) {
  const webhookUrl = env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: message }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      logger.warn("slack_alert_delivery_failed", { type, statusCode: response.status });
    }
  } catch {
    logger.warn("slack_alert_delivery_failed", { type });
  }
}

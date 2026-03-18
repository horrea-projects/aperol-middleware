import type { Handler } from "@netlify/functions";
import { assertConfig } from "../../src/config";
import { logger } from "../../src/utils/logger";
import { withExecutionLock } from "../../src/utils/locks";
import { runStockSync } from "../../src/jobs/stockSync";
import { runShipmentSync } from "../../src/jobs/shipmentSync";

export const handler: Handler = async () => {
  try {
    assertConfig();
  } catch (err) {
    logger.error("config_error", { error: String(err) });
    return {
      statusCode: 500,
      body: "Configuration invalide"
    };
  }

  const result = await withExecutionLock(60 * 9, async () => {
    await Promise.allSettled([runStockSync(), runShipmentSync()]);
    return true;
  });

  if (result === null) {
    return {
      statusCode: 200,
      body: "Exécution déjà en cours (lock actif)"
    };
  }

  return {
    statusCode: 200,
    body: "Sync UK terminée"
  };
};


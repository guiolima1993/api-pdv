import cron from "node-cron";
import { config } from "../config";
import { logger } from "../logger";
import { runSyncSafely } from "./syncRunner";

export function startScheduler(): void {
  if (config.sync.internalCronEnabled) {
    cron.schedule(config.sync.cron, () => {
      void runSyncSafely().catch(() => undefined);
    });
    logger.info({ cron: config.sync.cron }, "Agendamento de sincronizacao iniciado");
  } else {
    logger.info("Agendamento interno desativado (SYNC_INTERNAL_CRON_ENABLED=false) - usando scheduler externo");
  }

  if (config.sync.runOnStartup) {
    void runSyncSafely().catch(() => undefined);
  }
}

import cron from "node-cron";
import { config } from "../config";
import { logger } from "../logger";
import { runSyncSafely } from "./syncRunner";

export function startScheduler(): void {
  cron.schedule(config.sync.cron, () => {
    void runSyncSafely().catch(() => undefined);
  });
  logger.info({ cron: config.sync.cron }, "Agendamento de sincronizacao iniciado");

  if (config.sync.runOnStartup) {
    void runSyncSafely().catch(() => undefined);
  }
}

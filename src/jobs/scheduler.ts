import cron from "node-cron";
import { config } from "../config";
import { logger } from "../logger";
import { runSync } from "../services/syncService";

let running = false;

async function safeRunSync(): Promise<void> {
  if (running) {
    logger.warn("Sincronizacao anterior ainda em execucao, pulando este ciclo");
    return;
  }
  running = true;
  try {
    await runSync();
  } catch (err) {
    logger.error({ err }, "Erro inesperado durante a sincronizacao");
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  cron.schedule(config.sync.cron, () => {
    void safeRunSync();
  });
  logger.info({ cron: config.sync.cron }, "Agendamento de sincronizacao iniciado");

  if (config.sync.runOnStartup) {
    void safeRunSync();
  }
}

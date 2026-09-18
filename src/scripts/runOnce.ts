import "../db";
import { logger } from "../logger";
import { runSync } from "../services/syncService";

runSync()
  .then((summary) => {
    logger.info(summary, "Sincronizacao manual concluida");
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, "Sincronizacao manual falhou");
    process.exit(1);
  });

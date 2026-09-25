import { init } from "../db";
import { logger } from "../logger";
import { runSync } from "../services/syncService";

init()
  .then(() => runSync())
  .then((summary) => {
    logger.info(summary, "Sincronizacao manual concluida");
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, "Sincronizacao manual falhou");
    process.exit(1);
  });

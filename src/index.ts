import { init } from "./db";
import { config } from "./config";
import { logger } from "./logger";
import { createServer } from "./server";
import { startScheduler } from "./jobs/scheduler";

init()
  .then(() => {
    const app = createServer();
    app.listen(config.server.port, () => {
      logger.info({ port: config.server.port }, "Servico pdv-polgo-bridge no ar");
      startScheduler();
    });
  })
  .catch((err) => {
    logger.error({ err: String(err) }, "Falha ao inicializar banco de dados");
    process.exit(1);
  });

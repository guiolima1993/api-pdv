import "./db";
import { config } from "./config";
import { logger } from "./logger";
import { createServer } from "./server";
import { startScheduler } from "./jobs/scheduler";

const app = createServer();

app.listen(config.server.port, () => {
  logger.info({ port: config.server.port }, "Servico pdv-polgo-bridge no ar");
  startScheduler();
});

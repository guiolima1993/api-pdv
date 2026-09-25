import express from "express";
import { config } from "./config";
import { countByStatus } from "./db";
import { triggerSyncInBackground } from "./jobs/syncRunner";

export function createServer() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/sync/status", (_req, res) => {
    res.json({ byStatus: countByStatus() });
  });

  app.post("/sync/trigger", (req, res) => {
    if (req.header("X-API-KEY") !== config.server.adminApiKey) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    // Fire-and-forget: responde na hora pra caber em janelas curtas de
    // timeout de schedulers externos (ex.: cron-job.org, 30s no plano free).
    // O resultado da sincronizacao fica disponivel em GET /sync/status.
    const { accepted } = triggerSyncInBackground();
    if (!accepted) {
      res.status(409).json({ message: "Sincronizacao ja em execucao" });
      return;
    }
    res.status(202).json({ message: "Sincronizacao iniciada" });
  });

  return app;
}

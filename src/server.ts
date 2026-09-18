import express from "express";
import { config } from "./config";
import { logger } from "./logger";
import { runSync } from "./services/syncService";
import { countByStatus } from "./db";

export function createServer() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/sync/status", (_req, res) => {
    res.json({ byStatus: countByStatus() });
  });

  app.post("/sync/trigger", async (req, res) => {
    if (req.header("X-API-KEY") !== config.server.adminApiKey) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    try {
      const summary = await runSync();
      res.json({ summary });
    } catch (err) {
      logger.error({ err }, "Falha ao executar sincronizacao manual");
      res.status(500).json({ message: "Falha ao executar sincronizacao" });
    }
  });

  return app;
}

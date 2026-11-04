import express from "express";
import { config } from "./config";
import { countByStatus, getSyncCursor, getSyncedCupom, listByStatus } from "./db";
import { triggerSyncInBackground } from "./jobs/syncRunner";
import { parseCuponsEditados, recuperarCuponsEditados } from "./services/recoveryService";
import { parseDateOnly } from "./utils/dateUtils";
import { logger } from "./logger";
import { describeHttpError } from "./utils/errorUtils";

const MAX_DIAS_REPROCESSAMENTO = 31;
const MAX_CUPONS_RECUPERACAO = 30;

function isAdmin(req: express.Request, res: express.Response): boolean {
  if (req.header("X-API-KEY") !== config.server.adminApiKey) {
    res.status(401).json({ message: "Unauthorized" });
    return false;
  }
  return true;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createServer() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.setHeader("X-PDV-Release", "edited-cupons-3");
    res.json({ status: "ok" });
  });

  app.get("/sync/status", async (_req, res) => {
    res.json({ byStatus: await countByStatus(), lastSyncedAt: (await getSyncCursor()) ?? null });
  });

  app.get("/sync/errors", async (req, res) => {
    if (!isAdmin(req, res)) return;
    const limit = Number(req.query.limit) || 20;
    res.json({ errors: await listByStatus("error", limit) });
  });

  app.get("/sync/cupom/:filial/:vendaId", async (req, res) => {
    if (!isAdmin(req, res)) return;
    const filial = Number(req.params.filial);
    const vendaId = Number(req.params.vendaId);
    if (!Number.isSafeInteger(filial) || filial <= 0 || !Number.isSafeInteger(vendaId) || vendaId <= 0) {
      res.status(400).json({ message: "Filial e vendaId devem ser numeros inteiros positivos" });
      return;
    }
    try {
      const cupom = await getSyncedCupom(vendaId, filial);
      if (!cupom) {
        res.status(404).json({ message: "Cupom ainda nao processado pelo sync" });
        return;
      }
      res.json({ cupom });
    } catch (err) {
      logger.error({ err: describeHttpError(err), vendaId, filial }, "Falha ao consultar status do cupom");
      res.status(503).json({ message: "Nao foi possivel consultar o cupom; tente novamente" });
    }
  });

  app.post("/sync/trigger", (req, res) => {
    if (!isAdmin(req, res)) return;
    const de = typeof req.query.de === "string" ? req.query.de : undefined;
    const ate = typeof req.query.ate === "string" ? req.query.ate : undefined;
    let range: { from: Date; to: Date } | undefined;
    if (req.query.de !== undefined || req.query.ate !== undefined) {
      try {
        if (!de || !ate) throw new Error("Informe de e ate juntos (YYYY-MM-DD)");
        range = { from: parseDateOnly(de), to: parseDateOnly(ate) };
        if (range.from > range.to) throw new Error("de nao pode ser posterior a ate");
        const dias = (range.to.getTime() - range.from.getTime()) / 86_400_000 + 1;
        if (dias > MAX_DIAS_REPROCESSAMENTO) {
          throw new Error(`Intervalo maximo de ${MAX_DIAS_REPROCESSAMENTO} dias por reprocessamento`);
        }
      } catch (err) {
        res.status(400).json({ message: errorMessage(err) });
        return;
      }
    }
    // Fire-and-forget: responde na hora pra caber em janelas curtas de
    // timeout de schedulers externos (ex.: cron-job.org, 30s no plano free).
    // O resultado da sincronizacao fica disponivel em GET /sync/status.
    const { accepted } = triggerSyncInBackground(range);
    if (!accepted) {
      res.status(409).json({ message: "Sincronizacao ja em execucao" });
      return;
    }
    res.status(202).json({
      message: range ? `Reprocessamento iniciado (${de} ate ${ate})` : "Sincronizacao iniciada",
    });
  });

  // CPF incluido no PDV depois da impressao que nao chega na TabletCloud: envia com o CPF
  // do comprovante editado. Sem "enviar": true apenas confere e simula.
  app.post("/sync/recuperar-editados", async (req, res) => {
    if (!isAdmin(req, res)) return;
    const body = (req.body ?? {}) as { enviar?: unknown; cupons?: unknown };
    if (body.enviar !== undefined && typeof body.enviar !== "boolean") {
      res.status(400).json({ message: "enviar deve ser true ou false" });
      return;
    }
    try {
      const cupons = parseCuponsEditados(body.cupons);
      if (cupons.length > MAX_CUPONS_RECUPERACAO) {
        throw new Error(`Maximo de ${MAX_CUPONS_RECUPERACAO} cupons por chamada`);
      }
    } catch (err) {
      res.status(400).json({ message: errorMessage(err) });
      return;
    }
    try {
      const resultados = await recuperarCuponsEditados(body.cupons, body.enviar === true);
      res.json({ enviar: body.enviar === true, resultados });
    } catch (err) {
      const message = errorMessage(err);
      logger.error({ err: describeHttpError(err) }, "Falha na recuperacao de cupons editados");
      res.status(message.startsWith("Outra sincronizacao") ? 409 : 422).json({ message });
    }
  });

  return app;
}

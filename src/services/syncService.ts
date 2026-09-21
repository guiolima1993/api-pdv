import { config } from "../config";
import { logger } from "../logger";
import { TabletCloudClient } from "../clients/tabletCloudClient";
import { PolgoClient } from "../clients/polgoClient";
import { mapCupomToDocumentoFiscal, UnidentifiedConsumerError } from "../mappers/cupomToDocumentoFiscal";
import { chunkDateRange } from "../utils/dateUtils";
import { getSyncCursor, getSyncedCupom, setSyncCursor, upsertSyncedCupom } from "../db";
import { TabletCloudCupom } from "../types/tabletCloud";

const tabletCloud = new TabletCloudClient();
const polgo = new PolgoClient();

export interface SyncSummary {
  processed: number;
  sent: number;
  canceled: number;
  skipped: number;
  errors: number;
}

function isCancelled(cupom: TabletCloudCupom): boolean {
  return Boolean(cupom.iscancelado || cupom.isestornado);
}

async function processCupom(cupom: TabletCloudCupom, summary: SyncSummary): Promise<void> {
  const existing = getSyncedCupom(cupom.venda_id, cupom.loja_id);

  // Ja enviada anteriormente e agora aparece cancelada/estornada no PDV -> cancelar na Polgo tambem.
  if (existing?.status === "sent" && isCancelled(cupom)) {
    try {
      if (existing.polgo_document_id) {
        await polgo.cancelarDocumentoFiscal(existing.polgo_document_id);
      }
      upsertSyncedCupom({
        venda_id: cupom.venda_id,
        cod_filial: cupom.loja_id,
        status: "canceled",
        polgo_document_id: existing.polgo_document_id,
        attempts: existing.attempts,
      });
      summary.canceled += 1;
    } catch (err) {
      logger.error({ err, vendaId: cupom.venda_id }, "Falha ao cancelar documento fiscal na Polgo");
      upsertSyncedCupom({
        venda_id: cupom.venda_id,
        cod_filial: cupom.loja_id,
        status: "error",
        attempts: existing.attempts + 1,
        last_error: String(err),
      });
      summary.errors += 1;
    }
    return;
  }

  // Ja processada (enviada, cancelada ou ignorada de forma definitiva) e sem mudanca de estado.
  if (existing && existing.status !== "error") {
    return;
  }

  // Venda cancelada/estornada e nunca enviada -> nao ha o que assimilar ao sorteio.
  if (isCancelled(cupom)) {
    upsertSyncedCupom({ venda_id: cupom.venda_id, cod_filial: cupom.loja_id, status: "skipped" });
    summary.skipped += 1;
    return;
  }

  try {
    const payload = mapCupomToDocumentoFiscal(cupom);
    const retorno = await polgo.inserirDocumentoFiscal(payload);
    upsertSyncedCupom({
      venda_id: cupom.venda_id,
      cod_filial: cupom.loja_id,
      status: "sent",
      polgo_document_id: retorno.id,
      attempts: (existing?.attempts ?? 0) + 1,
    });
    summary.sent += 1;
  } catch (err) {
    if (err instanceof UnidentifiedConsumerError) {
      logger.warn({ vendaId: cupom.venda_id }, err.message);
      upsertSyncedCupom({ venda_id: cupom.venda_id, cod_filial: cupom.loja_id, status: "skipped", last_error: err.message });
      summary.skipped += 1;
      return;
    }
    logger.error({ err, vendaId: cupom.venda_id }, "Falha ao enviar documento fiscal para a Polgo");
    upsertSyncedCupom({
      venda_id: cupom.venda_id,
      cod_filial: cupom.loja_id,
      status: "error",
      attempts: (existing?.attempts ?? 0) + 1,
      last_error: String(err),
    });
    summary.errors += 1;
  }
}

export async function runSync(): Promise<SyncSummary> {
  const summary: SyncSummary = { processed: 0, sent: 0, canceled: 0, skipped: 0, errors: 0 };

  const to = new Date();
  const cursor = getSyncCursor();
  const from = cursor
    ? new Date(cursor)
    : new Date(Date.now() - config.sync.initialLookbackDays * 24 * 60 * 60 * 1000);

  logger.info({ from, to }, "Iniciando sincronizacao TabletCloud -> Polgo");

  const filiais = await tabletCloud.resolveFiliais();
  logger.info({ total: filiais.length }, "Filiais a sincronizar neste ciclo");

  for (const { from: chunkFrom, to: chunkTo } of chunkDateRange(from, to)) {
    const cupons = await tabletCloud.getCuponsInRange(chunkFrom, chunkTo, filiais);
    logger.info({ chunkFrom, chunkTo, total: cupons.length }, "Cupons recebidos da TabletCloud");

    for (const cupom of cupons) {
      summary.processed += 1;
      await processCupom(cupom, summary);
    }
  }

  setSyncCursor(to.toISOString());
  logger.info(summary, "Sincronizacao finalizada");
  return summary;
}

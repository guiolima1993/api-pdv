import { config } from "../config";
import { logger } from "../logger";
import { AxiosError } from "axios";
import { TabletCloudClient } from "../clients/tabletCloudClient";
import { PolgoClient, PolgoEnvioAdiadoError } from "../clients/polgoClient";
import {
  FORA_DA_JANELA_LOCAL_MARKER,
  ForaDoPrazoDaCampanhaError,
  isDentroDaJanelaDaCampanha,
  mapCupomToDocumentoFiscal,
  SEM_CPF_MARKER,
  getCpfConsumidor,
  isNotaFiscalValida,
  UnidentifiedConsumerError,
} from "../mappers/cupomToDocumentoFiscal";
import { chunkDateRange } from "../utils/dateUtils";
import { describeHttpError } from "../utils/errorUtils";
import { getSyncCursor, getSyncedCupom, setSyncCursor, upsertSyncedCupom, withSyncLock } from "../db";
import { TabletCloudCupom } from "../types/tabletCloud";

// Processa a lista com no maximo `limit` itens em voo simultaneamente, mantendo a
// ordem de disparo mas sem esperar um terminar para comecar o proximo.
async function processWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  async function runNext(): Promise<void> {
    const current = index++;
    if (current >= items.length) return;
    await worker(items[current]);
    return runNext();
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(workers);
}

const tabletCloud = new TabletCloudClient();
const polgo = new PolgoClient();

export interface SyncSummary {
  processed: number;
  sent: number;
  canceled: number;
  skipped: number;
  errors: number;
  // Envios adiados neste ciclo porque a Polgo estava indisponivel (circuit breaker).
  deferred: number;
}

// Circuit breaker por ciclo: quando a Polgo fica lenta/fora (timeouts, conexao recusada),
// cada envio pendente esperaria o timeout inteiro (30s) e um ciclo com dezenas de
// pendentes levaria dezenas de minutos - bem alem da janela em que a Hostinger derruba
// o processo por inatividade HTTP. Apos N falhas de rede consecutivas no mesmo ciclo,
// os demais envios sao adiados (cupom fica em "error" sem bater na Polgo) e o ciclo
// termina rapido; o proximo ciclo tenta de novo do zero.
const POLGO_FALHAS_CONSECUTIVAS_PARA_ABRIR = 3;
const POLGO_INDISPONIVEL_MARKER = "Polgo indisponivel (circuit breaker aberto neste ciclo)";

class PolgoCircuitBreaker {
  private falhasConsecutivas = 0;
  private aberto = false;

  isAberto(): boolean {
    return this.aberto;
  }

  registrarSucesso(): void {
    this.falhasConsecutivas = 0;
  }

  registrarFalhaDeRede(): void {
    this.falhasConsecutivas += 1;
    if (!this.aberto && this.falhasConsecutivas >= POLGO_FALHAS_CONSECUTIVAS_PARA_ABRIR) {
      this.aberto = true;
      logger.error(
        `Polgo indisponivel: ${this.falhasConsecutivas} falhas de rede consecutivas - demais envios deste ciclo adiados para o proximo`
      );
    }
  }
}

// Timeout, DNS, conexao recusada/resetada, 5xx: problemas do lado da Polgo (ou da rede),
// nao do documento. Qualquer 4xx e' resposta "de verdade" e nao conta.
function isFalhaDeRedePolgo(err: unknown): boolean {
  const axiosErr = err as AxiosError;
  if (!axiosErr?.isAxiosError) return false;
  const status = axiosErr.response?.status;
  if (status !== undefined) return status >= 500;
  return true;
}

const VENDA_CANCELADA_MARKER = "Venda cancelada/estornada no PDV";

// A TabletCloud marca `iscancelado` em vendas de mesa com NFC-e autorizada e nao cancelada
// (ex: item cancelado antes do fechamento). Nesses casos a venda e' valida.
export function isCancelled(cupom: TabletCloudCupom): boolean {
  if (cupom.isestornado) return true;
  return Boolean(cupom.iscancelado) && !(cupom.notas ?? []).some(isNotaFiscalValida);
}

export async function processCupom(
  cupom: TabletCloudCupom,
  cnpjPorFilial: Map<string, string>,
  summary: SyncSummary,
  breaker = new PolgoCircuitBreaker(),
  cpfConfirmado?: string
): Promise<void> {
  const existing = await getSyncedCupom(cupom.venda_id, cupom.loja_id);

  // Ja enviada anteriormente e agora aparece cancelada/estornada no PDV -> cancelar na Polgo tambem.
  if (existing?.status === "sent" && isCancelled(cupom)) {
    try {
      if (existing.polgo_document_id) {
        await polgo.cancelarDocumentoFiscal(existing.polgo_document_id);
      }
      await upsertSyncedCupom({
        venda_id: cupom.venda_id,
        cod_filial: cupom.loja_id,
        status: "canceled",
        polgo_document_id: existing.polgo_document_id,
        attempts: existing.attempts,
      });
      summary.canceled += 1;
    } catch (err) {
      logger.error({ err: describeHttpError(err), vendaId: cupom.venda_id }, "Falha ao cancelar documento fiscal na Polgo");
      await upsertSyncedCupom({
        venda_id: cupom.venda_id,
        cod_filial: cupom.loja_id,
        status: "error",
        attempts: existing.attempts + 1,
        last_error: JSON.stringify(describeHttpError(err)),
      });
      summary.errors += 1;
    }
    return;
  }

  // Ja processada (enviada, cancelada ou ignorada de forma definitiva) e sem mudanca de estado.
  // Excecao: pulada pelo filtro LOCAL de janela (POLGO_CAMPANHA_INICIO/FIM) e a janela
  // configurada agora inclui a data da venda (ex: env ajustada depois de uma prorrogacao
  // da campanha) - nesse caso volta a ser candidata a envio.
  if (existing && existing.status !== "error") {
    const puladaPorJanelaLocal =
      existing.status === "skipped" && (existing.last_error ?? "").includes(FORA_DA_JANELA_LOCAL_MARKER);
    // Puladas como canceladas (registros antigos sem last_error) que agora sao validas.
    const puladaComoCancelada =
      existing.status === "skipped" &&
      (!existing.last_error || existing.last_error.includes(VENDA_CANCELADA_MARKER)) &&
      !isCancelled(cupom);
    // Puladas por falta de CPF e que agora tem CPF: o PDV deixa editar o CPF depois da
    // venda impressa, e o cupom editado continua valido para a campanha.
    const puladaSemCpfQueGanhouCpf =
      existing.status === "skipped" &&
      (existing.last_error ?? "").includes(SEM_CPF_MARKER) &&
      Boolean(cpfConfirmado ?? getCpfConsumidor(cupom));
    if (
      !(puladaPorJanelaLocal && isDentroDaJanelaDaCampanha(cupom)) &&
      !puladaComoCancelada && !puladaSemCpfQueGanhouCpf
    ) {
      return;
    }
  }

  // Venda cancelada/estornada e nunca enviada -> nao ha o que assimilar ao sorteio.
  if (isCancelled(cupom)) {
    await upsertSyncedCupom({
      venda_id: cupom.venda_id,
      cod_filial: cupom.loja_id,
      status: "skipped",
      last_error: VENDA_CANCELADA_MARKER,
    });
    summary.skipped += 1;
    return;
  }

  try {
    const cnpjEmitente = cnpjPorFilial.get(String(cupom.loja_id));
    if (!cnpjEmitente) {
      logger.warn({ vendaId: cupom.venda_id, lojaId: cupom.loja_id }, "Filial sem CNPJ cadastrado na TabletCloud - venda ignorada");
      await upsertSyncedCupom({
        venda_id: cupom.venda_id,
        cod_filial: cupom.loja_id,
        status: "skipped",
        last_error: "Filial sem CNPJ cadastrado na TabletCloud",
      });
      summary.skipped += 1;
      return;
    }
    const payload = mapCupomToDocumentoFiscal(cupom, cnpjEmitente, cpfConfirmado);
    // So' chega aqui cupom apto (com CPF, dentro da janela). Se a Polgo ja' se mostrou
    // indisponivel neste ciclo, nao gasta 30s de timeout: adia pro proximo ciclo.
    if (breaker.isAberto()) {
      await upsertSyncedCupom({
        venda_id: cupom.venda_id,
        cod_filial: cupom.loja_id,
        status: "error",
        attempts: existing?.attempts ?? 0,
        last_error: existing?.last_error ?? POLGO_INDISPONIVEL_MARKER,
      });
      summary.deferred += 1;
      return;
    }
    // Rechecado DENTRO do rate limiter: com SYNC_CONCURRENCY=20, varios cupons ja' podem
    // estar na fila quando o breaker abre - sem isso cada um ainda esperaria o timeout.
    const retorno = await polgo.inserirDocumentoFiscal(payload, () => breaker.isAberto());
    breaker.registrarSucesso();
    await upsertSyncedCupom({
      venda_id: cupom.venda_id,
      cod_filial: cupom.loja_id,
      status: "sent",
      polgo_document_id: retorno.id,
      attempts: (existing?.attempts ?? 0) + 1,
    });
    summary.sent += 1;
  } catch (err) {
    if (err instanceof UnidentifiedConsumerError || err instanceof ForaDoPrazoDaCampanhaError) {
      // Casos comuns/esperados (sem CPF ou venda anterior/posterior a campanha): nao logamos
      // individualmente para nao inundar os logs, so marcamos como skipped.
      await upsertSyncedCupom({ venda_id: cupom.venda_id, cod_filial: cupom.loja_id, status: "skipped", last_error: err.message });
      summary.skipped += 1;
      return;
    }
    // Polgo ja tem esse numeroDocumento (normalmente sobra de reenvio apos perda do cursor
    // local) - terminal, nao adianta tentar de novo: sem isso, um cupom em status "error"
    // fica sendo retentado para sempre em todo ciclo (ver "existing.status !== 'error'" acima).
    const httpErr = describeHttpError(err);
    if (err instanceof PolgoEnvioAdiadoError) {
      await upsertSyncedCupom({
        venda_id: cupom.venda_id,
        cod_filial: cupom.loja_id,
        status: "error",
        attempts: existing?.attempts ?? 0,
        last_error: existing?.last_error ?? POLGO_INDISPONIVEL_MARKER,
      });
      summary.deferred += 1;
      return;
    }
    if (isFalhaDeRedePolgo(err)) breaker.registrarFalhaDeRede();
    const mensagemPolgo = ((httpErr.data as { mensagem?: string } | undefined)?.mensagem ?? "").toLowerCase();
    if (mensagemPolgo.includes("já inserido") || mensagemPolgo.includes("ja inserido")) {
      await upsertSyncedCupom({
        venda_id: cupom.venda_id,
        cod_filial: cupom.loja_id,
        status: "skipped",
        last_error: "Ja existe na Polgo (documento ja inserido) - tratado como concluido",
      });
      summary.skipped += 1;
      return;
    }
    // A propria Polgo rejeitou a data da venda como fora do prazo da campanha (a janela
    // deles diverge da nossa POLGO_CAMPANHA_INICIO/FIM). Retentar nao muda o resultado,
    // entao e' terminal: so volta a ser enviada se alguem reabrir manualmente no banco.
    if (mensagemPolgo.includes("fora do prazo")) {
      await upsertSyncedCupom({
        venda_id: cupom.venda_id,
        cod_filial: cupom.loja_id,
        status: "skipped",
        attempts: (existing?.attempts ?? 0) + 1,
        last_error: `Polgo rejeitou como fora do prazo da campanha: ${
          (httpErr.data as { mensagem?: string } | undefined)?.mensagem
        } (dtmovimento ${cupom.dtmovimento})`,
      });
      summary.skipped += 1;
      return;
    }
    // Embutido na mensagem (nao so nos campos estruturados) porque o painel simplificado
    // da Hostinger so exibe o texto da mensagem de log.
    logger.error(
      { err: httpErr, vendaId: cupom.venda_id },
      `Falha ao enviar documento fiscal para a Polgo (venda ${cupom.venda_id}, filial ${cupom.loja_id}, dtmovimento original "${cupom.dtmovimento}")`
    );
    await upsertSyncedCupom({
      venda_id: cupom.venda_id,
      cod_filial: cupom.loja_id,
      status: "error",
      attempts: (existing?.attempts ?? 0) + 1,
      last_error: JSON.stringify({ ...httpErr, dtmovimentoOriginal: cupom.dtmovimento }),
    });
    summary.errors += 1;
  }
}

export interface SyncRange {
  from: Date;
  to: Date;
}

export async function runSync(range?: SyncRange): Promise<SyncSummary> {
  if (range && (
    !Number.isFinite(range.from.getTime()) || !Number.isFinite(range.to.getTime()) ||
    range.from > range.to
  )) {
    throw new Error("Intervalo de reprocessamento invalido");
  }
  return withSyncLock(() => runSyncUnlocked(range));
}

async function runSyncUnlocked(range?: SyncRange): Promise<SyncSummary> {
  const summary: SyncSummary = { processed: 0, sent: 0, canceled: 0, skipped: 0, errors: 0, deferred: 0 };
  const breaker = new PolgoCircuitBreaker();

  const to = range?.to ?? new Date();
  const cursor = range ? undefined : await getSyncCursor();
  // Recua o cursor para continuar enxergando cupons editados depois de impressos (ex: CPF
  // incluido no PDV) mesmo quando a edicao cai depois da virada do dia: a TabletCloud so
  // filtra por dia inteiro, entao sem isso o dia anterior nunca mais seria buscado.
  const from = range?.from ?? (cursor
    ? new Date(new Date(cursor).getTime() - config.sync.editLookbackMinutes * 60 * 1000)
    : new Date(Date.now() - config.sync.initialLookbackDays * 24 * 60 * 60 * 1000));

  // O painel simplificado da Hostinger so mostra a mensagem, nao os campos estruturados,
  // por isso o range tambem vai embutido diretamente no texto.
  logger.info({ from, to }, `Iniciando sincronizacao TabletCloud -> Polgo (de ${from.toISOString()} ate ${to.toISOString()})`);

  const filiais = await tabletCloud.resolveFiliais();
  logger.info({ total: filiais.length }, "Filiais a sincronizar neste ciclo");
  const cnpjPorFilial = await tabletCloud.getCnpjPorFilial();

  for (const { from: chunkFrom, to: chunkTo } of chunkDateRange(from, to)) {
    const { totalFetched } = await tabletCloud.getCuponsInRange(chunkFrom, chunkTo, filiais, async (cupons) => {
      await processWithConcurrency(cupons, config.sync.concurrency, async (cupom) => {
        summary.processed += 1;
        await processCupom(cupom, cnpjPorFilial, summary, breaker);
      });
    });
    logger.info({ chunkFrom, chunkTo, total: totalFetched }, "Cupons recebidos da TabletCloud");
  }

  if (!range) await setSyncCursor(to.toISOString());
  // Resumo embutido no texto pelo mesmo motivo do log de inicio (painel da Hostinger).
  logger.info(
    summary,
    `Sincronizacao finalizada (processed=${summary.processed}, sent=${summary.sent}, canceled=${summary.canceled}, skipped=${summary.skipped}, errors=${summary.errors}, deferred=${summary.deferred})`
  );
  return summary;
}

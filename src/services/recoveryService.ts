import { TabletCloudClient } from "../clients/tabletCloudClient";
import { getSyncedCupom, withSyncLock } from "../db";
import { isNotaFiscalValida, mapCupomToDocumentoFiscal } from "../mappers/cupomToDocumentoFiscal";
import { parseDateOnly } from "../utils/dateUtils";
import { isCancelled, processCupom, SyncSummary } from "./syncService";

export interface CupomEditadoConfirmado {
  vendaId: number;
  filial: number;
  dataVenda: string;
  numeroNota: number;
  valorTotal: number;
  cpf: string;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseCuponsEditados(input: unknown): CupomEditadoConfirmado[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Informe uma lista nao vazia de cupons editados autorizados");
  }
  const seen = new Set<string>();
  return input.map((raw: unknown, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Correcao ${index + 1}: objeto invalido`);
    }
    const item = raw as Record<string, unknown>;
    if (
      !positiveInteger(item.vendaId) || !positiveInteger(item.filial) ||
      !positiveInteger(item.numeroNota) || typeof item.dataVenda !== "string" ||
      typeof item.valorTotal !== "number" || !Number.isFinite(item.valorTotal) || item.valorTotal < 0 ||
      typeof item.cpf !== "string" || !/^[\d.\s-]+$/.test(item.cpf)
    ) {
      throw new Error(`Correcao ${index + 1}: informe vendaId, filial, dataVenda, numeroNota, valorTotal e cpf validos`);
    }
    parseDateOnly(item.dataVenda);
    const cpf = item.cpf.replace(/\D/g, "");
    if (cpf.length !== 11) throw new Error(`Correcao ${index + 1}: CPF deve conter 11 digitos`);
    const key = `${item.filial}:${item.vendaId}`;
    if (seen.has(key)) throw new Error(`Correcao ${index + 1}: cupom repetido no lote`);
    seen.add(key);
    return {
      vendaId: item.vendaId, filial: item.filial, dataVenda: item.dataVenda,
      numeroNota: item.numeroNota, valorTotal: item.valorTotal, cpf,
    };
  });
}

export async function recuperarCuponsEditados(input: unknown, enviar = false) {
  const correcoes = parseCuponsEditados(input);
  const tabletCloud = new TabletCloudClient();

  const executar = async () => {
    const filiais = new Set(await tabletCloud.resolveFiliais());
    const cnpjPorFilial = await tabletCloud.getCnpjPorFilial();
    const planos = [];
    // Confere o lote inteiro antes do primeiro envio. O CPF vem do comprovante,
    // mas identidade, valor, data e situacao continuam vindo da TabletCloud.
    for (const correcao of correcoes) {
      if (!filiais.has(String(correcao.filial))) {
        throw new Error(`Filial ${correcao.filial} fora das filiais configuradas`);
      }
      const cupom = await tabletCloud.getCupom(correcao.vendaId, correcao.filial);
      const nota = cupom.notas?.find((n) => n.nnf === correcao.numeroNota && isNotaFiscalValida(n));
      if (
        cupom.dtmovimento.slice(0, 10) !== correcao.dataVenda ||
        Math.round(cupom.valortotal * 100) !== Math.round(correcao.valorTotal * 100) ||
        !nota
      ) {
        throw new Error(`Venda ${correcao.vendaId}, filial ${correcao.filial}: data, valor ou nota diverge do comprovante`);
      }
      if (isCancelled(cupom)) throw new Error(`Venda ${correcao.vendaId}: cupom cancelado/estornado`);
      const cnpj = cnpjPorFilial.get(String(correcao.filial));
      if (!cnpj) throw new Error(`Filial ${correcao.filial} sem CNPJ na TabletCloud`);
      const payload = mapCupomToDocumentoFiscal(cupom, cnpj, correcao.cpf);
      if (payload.numeroDocumento !== nota.chave_acesso) {
        throw new Error(`Venda ${correcao.vendaId}: multiplas notas; a chave selecionada diverge do comprovante`);
      }
      planos.push({ correcao, cupom, payload });
    }

    const resultados = [];
    for (const { correcao, cupom, payload } of planos) {
      let resultado = "simulado";
      let polgoId: string | null = null;
      if (enviar) {
        const existing = await getSyncedCupom(cupom.venda_id, cupom.loja_id);
        if (existing?.status === "sent") {
          resultado = "ja_enviado";
          polgoId = existing.polgo_document_id;
        } else {
          if (existing?.status === "canceled" || existing?.polgo_document_id) {
            throw new Error(`Venda ${cupom.venda_id}: documento ja vinculado/cancelado na Polgo; nao sera reinserido`);
          }
          const summary: SyncSummary = { processed: 1, sent: 0, canceled: 0, skipped: 0, errors: 0, deferred: 0 };
          await processCupom(cupom, cnpjPorFilial, summary, undefined, correcao.cpf);
          const saved = await getSyncedCupom(cupom.venda_id, cupom.loja_id);
          if (summary.sent !== 1 || saved?.status !== "sent") {
            throw new Error(`Venda ${cupom.venda_id}, filial ${cupom.loja_id}: envio nao concluido (status ${saved?.status ?? "ausente"}). Consulte last_error no banco antes de repetir`);
          }
          resultado = "enviado";
          polgoId = saved.polgo_document_id;
        }
      }
      resultados.push({
        vendaId: cupom.venda_id, filial: cupom.loja_id, resultado, polgoId,
        cpfMascarado: `***.***.***-${correcao.cpf.slice(-2)}`,
        numeroDocumento: payload.numeroDocumento, numeroNota: correcao.numeroNota,
        dataHoraEmissao: payload.dataHoraEmissao, valorTotal: payload.valorTotal,
      });
    }
    return resultados;
  };

  return enviar ? withSyncLock(executar) : executar();
}

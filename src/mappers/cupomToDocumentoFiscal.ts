import { config } from "../config";
import { TabletCloudCupom } from "../types/tabletCloud";
import { PolgoDocumentoFiscalInsertPayload } from "../types/polgo";
import { formatTabletCloudDateTime } from "../utils/dateUtils";

export class UnidentifiedConsumerError extends Error {
  constructor(vendaId: number, lojaId: number) {
    super(
      `Venda ${vendaId} (filial ${lojaId}) sem CPF de pessoa fisica do consumidor - nao pode ser enviada a Polgo`
    );
  }
}

// Marcador gravado no last_error dos cupons pulados pelo filtro local de janela. O
// syncService usa isso pra reprocessa-los caso a janela configurada mude depois
// (ex: campanha prorrogada) e a data da venda passe a estar dentro dela.
// Nao alterar o texto: precisa continuar casando com linhas ja gravadas no banco.
export const FORA_DA_JANELA_LOCAL_MARKER = "fora da janela da campanha";

export class ForaDoPrazoDaCampanhaError extends Error {
  constructor(vendaId: number, lojaId: number, dtmovimento: string) {
    super(
      `Venda ${vendaId} (filial ${lojaId}, dtmovimento ${dtmovimento}) esta ${FORA_DA_JANELA_LOCAL_MARKER} (${config.polgo.campanha.inicio} a ${config.polgo.campanha.fim}) - nao enviada a Polgo`
    );
  }
}

/** Data da venda (YYYY-MM-DD, horario local da TabletCloud) esta dentro de POLGO_CAMPANHA_INICIO..FIM? */
export function isDentroDaJanelaDaCampanha(cupom: TabletCloudCupom): boolean {
  const dataVenda = cupom.dtmovimento.slice(0, 10);
  return dataVenda >= config.polgo.campanha.inicio && dataVenda <= config.polgo.campanha.fim;
}

/**
 * Converte um cupom da TabletCloud no payload de POST /documentoFiscal/v1/inserir da Polgo.
 * Lanca UnidentifiedConsumerError quando nao ha CPF de pessoa fisica do consumidor
 * (clientes identificados so por CNPJ sao tratados como nao identificados: campanhas de
 * sorteio da Loteria Federal/Nota Fiscal Premiada valem para pessoa fisica, nao empresas),
 * pois a Polgo usa esse campo para assimilar a venda ao sorteio.
 * `cnpjEmitente` e o CNPJ (so digitos) da filial/loja, exigido pela Polgo no lugar
 * do codigo interno da TabletCloud.
 */
export function mapCupomToDocumentoFiscal(
  cupom: TabletCloudCupom,
  cnpjEmitente: string
): PolgoDocumentoFiscalInsertPayload {
  const cliente = cupom.clientes?.find((c) => {
    if (c.cancelado || !c.cpf_cnpj) return false;
    return c.cpf_cnpj.replace(/\D/g, "").length === 11;
  });
  const cpfCnpj = cliente?.cpf_cnpj?.replace(/\D/g, "");

  if (!cpfCnpj) {
    throw new UnidentifiedConsumerError(cupom.venda_id, cupom.loja_id);
  }

  if (!isDentroDaJanelaDaCampanha(cupom)) {
    throw new ForaDoPrazoDaCampanhaError(cupom.venda_id, cupom.loja_id, cupom.dtmovimento);
  }

  const chaveAcesso = cupom.notas?.find((n) => n.chave_acesso)?.chave_acesso;
  const numeroDocumento = chaveAcesso || `${cupom.loja_id}-${cupom.venda_id}`;

  const formaPagamento = cupom.formaPgtos?.map((f) => f.nome).filter(Boolean).join(",");

  const produtosServicos = cupom.itens?.filter((i) => !i.iscancelado).map((item) => ({
    codigo: String(item.codProdutoExterno ?? item.codproduto ?? ""),
    descricao: item.nomeProduto,
    quantidade: item.quantidade,
    valor: item.valortotal,
  }));

  return {
    usuario: cpfCnpj,
    cnpjCpf: cpfCnpj,
    numeroDocumento,
    dataHoraEmissao: formatTabletCloudDateTime(cupom.dtmovimento),
    valorTotal: cupom.valortotal,
    cnpjEmitente,
    campanha: {
      ano: config.polgo.campanha.ano,
      identificacao: config.polgo.campanha.identificacao,
    },
    produtosServicos,
    formaPagamento: formaPagamento || undefined,
    vendedor: cupom.nomeVendedor
      ? { codigo: cupom.codVendedorExterno ? String(cupom.codVendedorExterno) : undefined, nome: cupom.nomeVendedor }
      : undefined,
    consumidor: cliente?.dadosAdicionais?.nome ? { nome: cliente.dadosAdicionais.nome } : undefined,
    extra: `TabletCloud venda ${cupom.venda_id} - filial ${cupom.loja_id}`,
  };
}

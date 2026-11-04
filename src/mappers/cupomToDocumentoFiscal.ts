import { config } from "../config";
import { TabletCloudCliente, TabletCloudCupom, TabletCloudNotaFiscal } from "../types/tabletCloud";
import { PolgoDocumentoFiscalInsertPayload } from "../types/polgo";
import { formatTabletCloudDateTime } from "../utils/dateUtils";

// Nao alterar o texto: precisa continuar casando com linhas ja gravadas no banco.
export const SEM_CPF_MARKER = "sem CPF de pessoa fisica do consumidor";

export class UnidentifiedConsumerError extends Error {
  constructor(vendaId: number, lojaId: number) {
    super(`Venda ${vendaId} (filial ${lojaId}) ${SEM_CPF_MARKER} - nao pode ser enviada a Polgo`);
  }
}

function findClienteComCpf(cupom: TabletCloudCupom): TabletCloudCliente | undefined {
  return cupom.clientes?.find((c) => {
    if (c.cancelado || !c.cpf_cnpj) return false;
    return c.cpf_cnpj.replace(/\D/g, "").length === 11;
  });
}

export function isNotaFiscalValida(nota: TabletCloudNotaFiscal): boolean {
  return Boolean(nota.chave_acesso && nota.doc_emitido && !nota.cancelado &&
    (nota.status_sefaz ?? "100") === "100");
}

function findNotaComCpf(cupom: TabletCloudCupom): TabletCloudNotaFiscal | undefined {
  return cupom.notas?.find(
    (n) => isNotaFiscalValida(n) && n.docCliente?.replace(/\D/g, "").length === 11
  );
}

export function getCpfConsumidor(cupom: TabletCloudCupom): string | undefined {
  const cliente = findClienteComCpf(cupom);
  if (cliente?.cpf_cnpj) return cliente.cpf_cnpj.replace(/\D/g, "");

  // A identificacao fiscal pode existir sem um cadastro em clientes.
  return findNotaComCpf(cupom)?.docCliente?.replace(/\D/g, "");
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
  cnpjEmitente: string,
  cpfConfirmado?: string
): PolgoDocumentoFiscalInsertPayload {
  const cliente = findClienteComCpf(cupom);
  const cpfCnpj = cpfConfirmado ?? getCpfConsumidor(cupom);

  if (!cpfCnpj || !/^\d{11}$/.test(cpfCnpj)) {
    throw new UnidentifiedConsumerError(cupom.venda_id, cupom.loja_id);
  }

  if (!isDentroDaJanelaDaCampanha(cupom)) {
    throw new ForaDoPrazoDaCampanhaError(cupom.venda_id, cupom.loja_id, cupom.dtmovimento);
  }

  const notaComCpf = !cliente && !cpfConfirmado ? findNotaComCpf(cupom) : undefined;
  const chaveAcesso = notaComCpf?.chave_acesso ?? cupom.notas?.find(isNotaFiscalValida)?.chave_acesso ??
    cupom.notas?.find((n) => n.chave_acesso)?.chave_acesso;
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
    consumidor: cliente?.cpf_cnpj?.replace(/\D/g, "") === cpfCnpj && cliente?.dadosAdicionais?.nome
      ? { nome: cliente.dadosAdicionais.nome } : undefined,
    extra: `TabletCloud venda ${cupom.venda_id} - filial ${cupom.loja_id}` +
      (cpfConfirmado ? " - CPF confirmado em comprovante editado autorizado" : ""),
  };
}

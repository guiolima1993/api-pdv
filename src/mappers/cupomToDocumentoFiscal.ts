import { config } from "../config";
import { TabletCloudCupom } from "../types/tabletCloud";
import { PolgoDocumentoFiscalInsertPayload } from "../types/polgo";
import { toDateTime } from "../utils/dateUtils";

export class UnidentifiedConsumerError extends Error {
  constructor(vendaId: number, lojaId: number) {
    super(`Venda ${vendaId} (filial ${lojaId}) sem CPF/CNPJ do consumidor - nao pode ser enviada a Polgo`);
  }
}

/**
 * Converte um cupom da TabletCloud no payload de POST /documentoFiscal/v1/inserir da Polgo.
 * Lanca UnidentifiedConsumerError quando nao ha CPF/CNPJ do consumidor,
 * pois a Polgo usa esse campo para assimilar a venda ao sorteio.
 */
export function mapCupomToDocumentoFiscal(cupom: TabletCloudCupom): PolgoDocumentoFiscalInsertPayload {
  const cliente = cupom.Clientes?.find((c) => !c.Cancelado && c.Cpf_cnpj) ?? cupom.Clientes?.[0];
  const cpfCnpj = cliente?.Cpf_cnpj?.replace(/\D/g, "");

  if (!cpfCnpj) {
    throw new UnidentifiedConsumerError(cupom.Venda_id, cupom.Loja_id);
  }

  const chaveAcesso = cupom.Notas?.find((n) => n.Chave_acesso)?.Chave_acesso;
  const numeroDocumento = chaveAcesso || `${cupom.Loja_id}-${cupom.Venda_id}`;

  const formaPagamento = cupom.FormaPgtos?.map((f) => f.Nome).filter(Boolean).join(",");

  const produtosServicos = cupom.Itens?.filter((i) => !i.Iscancelado).map((item) => ({
    codigo: String(item.CodProdutoExterno ?? item.Codproduto ?? ""),
    descricao: item.NomeProduto,
    quantidade: item.Quantidade,
    valorUnitario: item.Quantidade ? Number((item.Valortotal / item.Quantidade).toFixed(2)) : item.Valortotal,
    valorTotal: item.Valortotal,
  }));

  return {
    usuario: cpfCnpj,
    numeroDocumento,
    dataHoraEmissao: toDateTime(new Date(cupom.Dtmovimento)),
    valorTotal: cupom.Valortotal,
    codigoEmitente: String(cupom.Loja_id),
    campanha: {
      ano: config.polgo.campanha.ano,
      identificacao: config.polgo.campanha.identificacao,
    },
    produtosServicos,
    formaPagamento: formaPagamento || undefined,
    vendedor: cupom.NomeVendedor
      ? { codigo: cupom.CodVendedorExterno ? String(cupom.CodVendedorExterno) : undefined, nome: cupom.NomeVendedor }
      : undefined,
    consumidor: cliente?.DadosAdicionais?.Nome ? { nome: cliente.DadosAdicionais.Nome } : undefined,
    extra: `TabletCloud venda ${cupom.Venda_id} - filial ${cupom.Loja_id}`,
  };
}

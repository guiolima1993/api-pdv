import { config } from "../config";
import { TabletCloudCupom } from "../types/tabletCloud";
import { PolgoDocumentoFiscalInsertPayload } from "../types/polgo";
import { formatTabletCloudDateTime } from "../utils/dateUtils";

export class UnidentifiedConsumerError extends Error {
  constructor(vendaId: number, lojaId: number) {
    super(`Venda ${vendaId} (filial ${lojaId}) sem CPF/CNPJ do consumidor - nao pode ser enviada a Polgo`);
  }
}

/**
 * Converte um cupom da TabletCloud no payload de POST /documentoFiscal/v1/inserir da Polgo.
 * Lanca UnidentifiedConsumerError quando nao ha CPF/CNPJ do consumidor,
 * pois a Polgo usa esse campo para assimilar a venda ao sorteio.
 * `cnpjEmitente` e o CNPJ (so digitos) da filial/loja, exigido pela Polgo no lugar
 * do codigo interno da TabletCloud.
 */
export function mapCupomToDocumentoFiscal(
  cupom: TabletCloudCupom,
  cnpjEmitente: string
): PolgoDocumentoFiscalInsertPayload {
  const cliente = cupom.clientes?.find((c) => !c.cancelado && c.cpf_cnpj) ?? cupom.clientes?.[0];
  const cpfCnpj = cliente?.cpf_cnpj?.replace(/\D/g, "");

  if (!cpfCnpj) {
    throw new UnidentifiedConsumerError(cupom.venda_id, cupom.loja_id);
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

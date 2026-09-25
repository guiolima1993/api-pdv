// Modelos parciais baseados na resposta JSON real da API TabletCloud (GET /cupom/get).
// IMPORTANTE: a documentacao oficial (https://api.tabletcloud.com.br/Help) mostra os campos
// em PascalCase (ex.: Venda_id), mas o serializer JSON da API retorna todos os campos em
// camelCase com a primeira letra minuscula (ex.: venda_id, dtmovimento, itens, clientes).
// Os nomes abaixo foram confirmados via inspecao direta de respostas reais da API.
// Mantidos apenas os campos usados pela integracao com a Polgo.

export interface TabletCloudItem {
  codproduto: number;
  codProdutoExterno?: number;
  nomeProduto: string;
  quantidade: number;
  valortotal: number;
  valordesconto?: number;
  valoracrescimo?: number;
  iscancelado?: boolean;
}

export interface TabletCloudCliente {
  cod: number;
  cliente_id?: number;
  cpf_cnpj?: string;
  cancelado?: boolean;
  email?: string;
  dadosAdicionais?: {
    nome?: string;
  } | null;
}

export interface TabletCloudFormaPgto {
  nome: string;
  valortotal: number;
}

export interface TabletCloudNotaFiscal {
  chave_acesso?: string;
  cancelado?: boolean;
  nnf?: number;
  doc_emitido?: boolean;
}

export interface TabletCloudCupom {
  venda_id: number;
  venda_id_pdv?: number;
  codcupom?: number;
  codempresa?: number;
  loja_id: number;
  terminal_id?: string;
  valortotal: number;
  isestornado?: boolean;
  iscancelado?: boolean;
  dtmovimento: string;
  codVendedorExterno?: number;
  nomeVendedor?: string;
  itens?: TabletCloudItem[];
  clientes?: TabletCloudCliente[];
  formaPgtos?: TabletCloudFormaPgto[];
  notas?: TabletCloudNotaFiscal[];
}


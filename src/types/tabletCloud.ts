// Modelos parciais baseados em Fiweb.Models.Venda.Cupom (https://api.tabletcloud.com.br/Help)
// Mantidos apenas os campos usados pela integracao com a Polgo.

export interface TabletCloudItem {
  Codproduto: number;
  CodProdutoExterno?: number;
  NomeProduto: string;
  Quantidade: number;
  Valortotal: number;
  Valordesconto?: number;
  Valoracrescimo?: number;
  Iscancelado?: boolean;
}

export interface TabletCloudCliente {
  Cod: number;
  Cliente_id?: number;
  Cpf_cnpj?: string;
  Cancelado?: boolean;
  Email?: string;
  DadosAdicionais?: {
    Nome?: string;
  };
}

export interface TabletCloudFormaPgto {
  Nome: string;
  Valortotal: number;
}

export interface TabletCloudNotaFiscal {
  Chave_acesso?: string;
  Cancelado?: boolean;
  Nnf?: number;
  Doc_emitido?: boolean;
}

export interface TabletCloudCupom {
  Venda_id: number;
  Venda_id_pdv?: number;
  Codcupom?: number;
  Codempresa?: number;
  Loja_id: number;
  Terminal_id?: string;
  Valortotal: number;
  Isestornado?: boolean;
  Iscancelado?: boolean;
  Dtmovimento: string;
  CodVendedorExterno?: number;
  NomeVendedor?: string;
  Itens?: TabletCloudItem[];
  Clientes?: TabletCloudCliente[];
  FormaPgtos?: TabletCloudFormaPgto[];
  Notas?: TabletCloudNotaFiscal[];
}

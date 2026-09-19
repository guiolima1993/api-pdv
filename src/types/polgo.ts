// Modelos parciais do payload esperado por POST /documentoFiscal/v1/inserir da Polgo
// https://documentacao.polgo.com.br

export interface PolgoCampanha {
  ano: number;
  identificacao: string;
}

export interface PolgoProdutoServico {
  codigo: string;
  descricao: string;
  quantidade: number;
  valor: number; // valor total do item (quantidade * unitario), conforme doc da Polgo
  codigoEAN?: string;
  unidade?: string;
  categoria?: string[];
  extra?: string;
}

export interface PolgoVendedor {
  codigo?: string;
  nome?: string;
}

export interface PolgoConsumidor {
  nome?: string;
}

export interface PolgoDocumentoFiscalInsertPayload {
  usuario: string; // CPF/CNPJ do consumidor
  cnpjCpf?: string; // CPF/CNPJ do consumidor (confirmar com a Polgo a diferenca em relacao a `usuario`)
  numeroDocumento: string;
  dataHoraEmissao: string; // YYYY-MM-DD HH:mm:ss
  valorTotal: number;
  cnpjEmitente?: string;
  codigoEmitente?: string;
  campanha: PolgoCampanha;
  produtosServicos?: PolgoProdutoServico[];
  formaPagamento?: string;
  extra?: string;
  vendedor?: PolgoVendedor;
  consumidor?: PolgoConsumidor;
  urlImagem?: string;
}

export interface PolgoDocumentoFiscalResponse {
  id: string;
  [key: string]: unknown;
}

export interface PolgoApiEnvelope<T> {
  status: number;
  mensagem: string;
  retorno: T;
}

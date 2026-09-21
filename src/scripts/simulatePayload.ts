import { logger } from "../logger";
import { TabletCloudClient } from "../clients/tabletCloudClient";
import { mapCupomToDocumentoFiscal } from "../mappers/cupomToDocumentoFiscal";

// Pega um cupom real e simula um CPF (ja que as lojas ainda nao coletam esse dado),
// so pra validar se o RESTO do mapeamento pra Polgo esta completo.
async function main(): Promise<void> {
  const tabletCloud = new TabletCloudClient();
  const filiais = (await tabletCloud.resolveFiliais()).slice(0, 10);

  const to = new Date();
  const from = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const cupons = await tabletCloud.getCuponsInRange(from, to, filiais);
  logger.info({ total: cupons.length }, "Cupons na amostra");

  const comItens = cupons.find((c) => (c.itens?.length ?? 0) > 0 && !Number.isNaN(new Date(c.dtmovimento).getTime()));
  if (!comItens) {
    logger.warn("Nenhum cupom com itens/notas encontrado na amostra");
    return;
  }

  const simulado = {
    ...comItens,
    clientes: [{ cod: 1, cpf_cnpj: "12345678900", dadosAdicionais: { nome: "Cliente Teste" } }],
  };

  const payload = mapCupomToDocumentoFiscal(simulado);
  logger.info({ payload }, "Payload completo simulado (com CPF fake) para a Polgo");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Falhou");
    process.exit(1);
  });

import { TabletCloudClient } from "../clients/tabletCloudClient";
import { logger } from "../logger";

async function main(): Promise<void> {
  const tc = new TabletCloudClient();
  const filiais = (await tc.resolveFiliais()).slice(0, 30);
  const to = new Date();
  const from = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
  const cupons = await tc.getCuponsInRange(from, to, filiais);
  logger.info({ total: cupons.length }, "total cupons buscados");
  const c = cupons.find((c) => (c as unknown as Record<string, unknown[]>).itens?.length > 0) as unknown as Record<string, unknown>;
  logger.info({ keys: Object.keys(c) }, "top level keys");
  const itens = c.itens as Record<string, unknown>[];
  logger.info({ itemKeys: Object.keys(itens[0]) }, "item keys");
  const clientes = c.clientes as Record<string, unknown>[] | undefined;
  if (clientes?.length) logger.info({ clienteKeys: Object.keys(clientes[0]) }, "cliente keys");
  const formaPgtos = c.formaPgtos as Record<string, unknown>[] | undefined;
  if (formaPgtos?.length) logger.info({ fpKeys: Object.keys(formaPgtos[0]) }, "formaPgto keys");
  const notas = c.notas as Record<string, unknown>[] | undefined;
  if (notas?.length) logger.info({ notaKeys: Object.keys(notas[0]) }, "nota keys");

  const cupomComCliente = cupons.find((c) => (c as unknown as Record<string, unknown[]>).clientes?.length > 0) as unknown as Record<string, unknown>;
  if (cupomComCliente) {
    const clientesReal = cupomComCliente.clientes as Record<string, unknown>[];
    logger.info({ cliente: clientesReal[0] }, "Exemplo real de cliente com dados");
  } else {
    logger.warn("Nenhum cupom com cliente preenchido nesta amostra");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Falhou");
    process.exit(1);
  });

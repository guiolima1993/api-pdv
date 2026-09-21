import { logger } from "../logger";
import { TabletCloudClient } from "../clients/tabletCloudClient";
import { mapCupomToDocumentoFiscal, UnidentifiedConsumerError } from "../mappers/cupomToDocumentoFiscal";
import { chunkDateRange } from "../utils/dateUtils";
import { TabletCloudCupom } from "../types/tabletCloud";

// Periodo de busca em dias, sobrescrevivel via `npx ts-node-dev ... testTabletCloud.ts 10`
const LOOKBACK_DAYS = Number(process.argv[2]) || 10;
// Limita quantas filiais testar, pra nao esperar a conta toda (355 lojas) em um teste rapido.
const MAX_FILIAIS = Number(process.argv[3]) || 5;

async function main(): Promise<void> {
  const tabletCloud = new TabletCloudClient();

  const todasFiliais = await tabletCloud.resolveFiliais();
  const filiais = todasFiliais.slice(0, MAX_FILIAIS);
  logger.info({ totalConta: todasFiliais.length, testando: filiais }, "Filiais resolvidas (amostra p/ teste)");

  const to = new Date();
  const from = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // TabletCloud limita cupom/get a intervalos de no maximo 10 dias, por isso o chunking.
  const cupons: TabletCloudCupom[] = [];
  for (const { from: chunkFrom, to: chunkTo } of chunkDateRange(from, to)) {
    const parcial = await tabletCloud.getCuponsInRange(chunkFrom, chunkTo, filiais);
    logger.info({ chunkFrom, chunkTo, total: parcial.length }, "Cupons recebidos neste bloco");
    cupons.push(...parcial);
  }
  logger.info({ from, to, total: cupons.length }, "Total de cupons recebidos");

  if (cupons.length === 0) {
    logger.warn("Nenhum cupom encontrado no periodo - nada para mapear");
    return;
  }

  logger.info({ exemplo: cupons[0] }, "Exemplo de cupom bruto (TabletCloud)");

  let mapeados = 0;
  let semConsumidor = 0;
  for (const cupom of cupons) {
    try {
      const payload = mapCupomToDocumentoFiscal(cupom);
      mapeados += 1;
      if (mapeados === 1) {
        logger.info({ payload }, "Exemplo de payload mapeado para a Polgo");
      }
    } catch (err) {
      if (err instanceof UnidentifiedConsumerError) {
        semConsumidor += 1;
      } else {
        throw err;
      }
    }
  }

  logger.info(
    { totalCupons: cupons.length, mapeadosComSucesso: mapeados, semCpfCnpj: semConsumidor },
    "Resumo do mapeamento cupom -> documento fiscal Polgo",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Teste TabletCloud falhou");
    process.exit(1);
  });

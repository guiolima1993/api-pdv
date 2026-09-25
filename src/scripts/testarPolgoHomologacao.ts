// Teste de ponta a ponta contra o ambiente de homologacao real da Polgo, usando
// os cupons de HOJE da TabletCloud. Nao usa o db.ts (nao marca nada como "sent"
// no armazenamento de producao) - e so pra validar que o envio funciona de fato.
import { logger } from "../logger";
import { TabletCloudClient } from "../clients/tabletCloudClient";
import { PolgoClient } from "../clients/polgoClient";
import { mapCupomToDocumentoFiscal, UnidentifiedConsumerError } from "../mappers/cupomToDocumentoFiscal";
import { describeHttpError } from "../utils/errorUtils";
import { TabletCloudCupom } from "../types/tabletCloud";

async function main(): Promise<void> {
  const tabletCloud = new TabletCloudClient();
  const polgo = new PolgoClient();

  const filiais = await tabletCloud.resolveFiliais();
  logger.info({ totalFiliais: filiais.length }, "Filiais resolvidas");
  const cnpjPorFilial = await tabletCloud.getCnpjPorFilial();

  const hoje = new Date();
  const cupons: TabletCloudCupom[] = [];
  await tabletCloud.getCuponsInRange(hoje, hoje, filiais, async (pagina) => {
    cupons.push(...pagina);
  });
  logger.info({ total: cupons.length }, "Cupons de hoje encontrados na TabletCloud");

  let semConsumidor = 0;
  let enviados = 0;
  let falhas = 0;
  const erros: { vendaId: number; lojaId: number; erro: string }[] = [];

  for (const cupom of cupons) {
    let payload;
    try {
      const cnpjEmitente = cnpjPorFilial.get(String(cupom.loja_id));
      if (!cnpjEmitente) {
        semConsumidor += 1;
        continue;
      }
      payload = mapCupomToDocumentoFiscal(cupom, cnpjEmitente);
    } catch (err) {
      if (err instanceof UnidentifiedConsumerError) {
        semConsumidor += 1;
        continue;
      }
      throw err;
    }

    try {
      const retorno = await polgo.inserirDocumentoFiscal(payload);
      enviados += 1;
      logger.info({ vendaId: cupom.venda_id, lojaId: cupom.loja_id, polgoId: retorno.id }, "Documento fiscal enviado com sucesso (homologacao)");
      // Respeita a recomendacao da Polgo de ate 2 requisicoes/segundo.
      await new Promise((resolve) => setTimeout(resolve, 600));
    } catch (err) {
      falhas += 1;
      const detalhe = describeHttpError(err);
      erros.push({ vendaId: cupom.venda_id, lojaId: cupom.loja_id, erro: JSON.stringify(detalhe) });
      logger.error({ vendaId: cupom.venda_id, lojaId: cupom.loja_id, err: detalhe }, "Falha ao enviar documento fiscal (homologacao)");
    }
  }

  logger.info(
    { totalCupons: cupons.length, semCpfCnpj: semConsumidor, enviados, falhas },
    "Resumo do teste de homologacao com a Polgo",
  );
  if (erros.length > 0) {
    logger.info({ erros }, "Detalhe das falhas");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Teste de homologacao falhou");
    process.exit(1);
  });

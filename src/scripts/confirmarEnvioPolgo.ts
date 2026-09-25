// Confirma, consultando a PROPRIA API da Polgo (nao so a resposta do POST), que os
// documentos enviados no teste de homologacao realmente foram persistidos do lado deles.
import { logger } from "../logger";
import { PolgoClient } from "../clients/polgoClient";
import { describeHttpError } from "../utils/errorUtils";

async function main(): Promise<void> {
  const polgo = new PolgoClient();
  const hoje = new Date().toISOString().slice(0, 10);

  const retorno = await polgo.listarDocumentosFiscais({
    anoCampanha: "2026",
    identificacaoCampanha: "CHEIRINHO",
    dataInicioEmissao: `${hoje} 00:00:00`,
    dataFimEmissao: `${hoje} 23:59:59`,
  });

  logger.info({ retorno }, "Documentos fiscais encontrados na Polgo para hoje");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: describeHttpError(err) }, "Falha ao consultar documentos na Polgo");
    process.exit(1);
  });

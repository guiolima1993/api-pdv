import { readFile } from "fs/promises";
import { parseArgs } from "util";
import { init } from "../db";
import { logger } from "../logger";
import { parseCuponsEditados, recuperarCuponsEditados } from "../services/recoveryService";
import { describeHttpError } from "../utils/errorUtils";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { arquivo: { type: "string" }, enviar: { type: "boolean", default: false } },
    allowPositionals: false,
  });
  if (!values.arquivo) throw new Error("Use --arquivo=/caminho/privado/cupons.json [--enviar]");
  const content = await readFile(values.arquivo, "utf8");
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error("Arquivo de cupons editados contem JSON invalido");
    throw err;
  }
  const correcoes = parseCuponsEditados(input);
  if (values.enviar) await init();
  const resultados = await recuperarCuponsEditados(correcoes, values.enviar);
  logger.info(
    { resultados },
    values.enviar ? "Recuperacao de cupons editados concluida" : "SIMULACAO: nenhum envio ou registro no banco; duplicidade sera conferida no envio real"
  );
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error({ err: describeHttpError(err) }, "Recuperacao nao concluida; envios anteriores do lote permanecem registrados");
  process.exit(1);
});

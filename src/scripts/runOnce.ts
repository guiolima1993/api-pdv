import { init } from "../db";
import { logger } from "../logger";
import { runSync } from "../services/syncService";
import { parseArgs } from "util";
import { parseDateOnly } from "../utils/dateUtils";

async function main() {
  const { values } = parseArgs({
    options: { de: { type: "string" }, ate: { type: "string" } },
    allowPositionals: false,
  });
  if (Boolean(values.de) !== Boolean(values.ate)) throw new Error("Informe --de e --ate juntos");
  const range = values.de && values.ate
    ? { from: parseDateOnly(values.de), to: parseDateOnly(values.ate) } : undefined;
  if (range && range.from > range.to) throw new Error("--de nao pode ser posterior a --ate");
  await init();
  return runSync(range);
}

main()
  .then((summary) => {
    logger.info(summary, "Sincronizacao manual concluida");
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, "Sincronizacao manual falhou");
    process.exit(1);
  });

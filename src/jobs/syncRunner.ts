import axios from "axios";
import { config } from "../config";
import { logger } from "../logger";
import { runSync, SyncSummary } from "../services/syncService";
import { describeHttpError } from "../utils/errorUtils";

// Guard compartilhado entre o cron interno (scheduler.ts) e o trigger HTTP
// manual/externo (server.ts) para nunca rodar duas sincronizacoes em paralelo.
let running = false;

export function isSyncRunning(): boolean {
  return running;
}

// Mantem o processo "ativo" aos olhos da hospedagem enquanto o sync roda (ver
// config.sync.keepAliveUrl). Retorna a funcao que para o ping.
function startKeepAlive(): () => void {
  const url = config.sync.keepAliveUrl;
  if (!url) return () => undefined;
  let avisouFalha = false;
  const timer = setInterval(() => {
    axios.get(url, { timeout: 5_000 }).catch((err) => {
      if (!avisouFalha) {
        avisouFalha = true;
        logger.warn({ err: describeHttpError(err), url }, "Keep-alive do sync falhou (seguira tentando em silencio)");
      }
    });
  }, config.sync.keepAliveIntervalMs);
  return () => clearInterval(timer);
}

async function runGuarded(): Promise<SyncSummary> {
  const stopKeepAlive = startKeepAlive();
  try {
    return await runSync();
  } finally {
    stopKeepAlive();
  }
}

// Roda a sincronizacao e aguarda o resultado (usado quando quem chama precisa
// do resumo, ex.: script de trigger manual local).
export async function runSyncSafely(): Promise<SyncSummary | null> {
  if (running) {
    logger.warn("Sincronizacao anterior ainda em execucao, pulando este ciclo");
    return null;
  }
  running = true;
  try {
    return await runGuarded();
  } catch (err) {
    logger.error({ err: describeHttpError(err) }, "Erro inesperado durante a sincronizacao");
    throw err;
  } finally {
    running = false;
  }
}

// Dispara a sincronizacao sem aguardar o resultado (fire-and-forget), pra
// endpoints HTTP que precisam responder rapido (ex.: cron-job.org com
// timeout curto). Erros sao apenas logados, nunca propagados.
export function triggerSyncInBackground(): { accepted: boolean } {
  if (running) {
    logger.warn("Sincronizacao anterior ainda em execucao, disparo em background ignorado");
    return { accepted: false };
  }
  running = true;
  runGuarded()
    .catch((err) => {
      logger.error({ err: describeHttpError(err) }, "Erro inesperado durante a sincronizacao em background");
    })
    .finally(() => {
      running = false;
    });
  return { accepted: true };
}

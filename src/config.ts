import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const config = {
  tabletCloud: {
    baseUrl: required("TABLETCLOUD_BASE_URL", "https://api.tabletcloud.com.br"),
    // Fluxo OAuth2 password grant (POST /token) - ver https://api.tabletcloud.com.br/Help
    username: required("TABLETCLOUD_USERNAME"),
    password: required("TABLETCLOUD_PASSWORD"),
    clientId: required("TABLETCLOUD_CLIENT_ID"),
    clientSecret: required("TABLETCLOUD_CLIENT_SECRET"),
    // Vazio = descobre automaticamente todas as filiais da conta via GET /filial/get
    filiais: (process.env.TABLETCLOUD_FILIAIS ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean),
    // Quantos lotes de filiais sao buscados em paralelo na TabletCloud (nao documentado
    // limite de rate-limit; usado pra nao estourar o tempo do ciclo de sync com muitas filiais).
    concurrency: optionalInt("TABLETCLOUD_CONCURRENCY", 5),
  },
  polgo: {
    baseUrl: required("POLGO_BASE_URL", "https://testews.polgo.com.br/polgo"),
    usuario: required("POLGO_USUARIO"),
    senha: required("POLGO_SENHA"),
    campanha: {
      ano: optionalInt("POLGO_CAMPANHA_ANO", new Date().getFullYear()),
      identificacao: required("POLGO_CAMPANHA_IDENTIFICACAO"),
      // Janela valida de datas de venda aceita pela campanha (a propria Polgo rejeita
      // fora disso com "Documento fiscal fora do prazo"); filtramos antes de enviar
      // pra nao desperdicar requisicoes e nao inflar o contador de erros com vendas
      // legitimamente anteriores/posteriores a campanha (ex: cupons de teste antigos).
      inicio: required("POLGO_CAMPANHA_INICIO", "2026-09-25"),
      fim: required("POLGO_CAMPANHA_FIM", "2026-10-31"),
    },
  },
  sync: {
    cron: process.env.SYNC_CRON || "*/10 * * * *",
    // Desliga o node-cron interno quando um scheduler externo (ex: cron-job.org batendo
    // em /sync/trigger) ja cobre o mesmo agendamento - evita os dois dispararem juntos
    // e colidirem (um deles toma 409 "ja em execucao").
    internalCronEnabled: (process.env.SYNC_INTERNAL_CRON_ENABLED ?? "true") === "true",
    initialLookbackDays: optionalInt("SYNC_INITIAL_LOOKBACK_DAYS", 1),
    runOnStartup: (process.env.SYNC_RUN_ON_STARTUP ?? "true") === "true",
    // Quantos cupons sao processados/enviados a Polgo em paralelo por vez.
    // Polgo recomendou ate 2 vendas distintas por segundo (sem hard-limit documentado).
    concurrency: optionalInt("SYNC_CONCURRENCY", 2),
  },
  server: {
    port: optionalInt("PORT", 3000),
    adminApiKey: required("ADMIN_API_KEY", "troque_esta_chave"),
  },
  database: {
    // MySQL (nao arquivo local): hospedagens gerenciadas tipo a Hostinger nao
    // persistem disco local entre deploys, entao o estado do sync (cursor +
    // status de cada cupom) precisa morar em algo externo ao container.
    host: required("DB_HOST", "localhost"),
    port: optionalInt("DB_PORT", 3306),
    name: required("DB_NAME"),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
  },
  logLevel: process.env.LOG_LEVEL || "info",
};

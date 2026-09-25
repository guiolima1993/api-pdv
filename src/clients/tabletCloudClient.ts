import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import { logger } from "../logger";
import { TabletCloudCupom } from "../types/tabletCloud";
import { toDateOnly } from "../utils/dateUtils";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: string | number;
}

interface TabletCloudPage<T> {
  total_on_this_page: number;
  total_records: number;
  total_pages: number;
  current_page: number;
  data: T[];
}

interface TabletCloudFilial {
  codigo: number;
  nome: string;
  cnpj?: string;
}

// Quantidade de codigos de filial por chamada, para nao estourar limite de tamanho de URL do servidor.
const FILIAIS_POR_LOTE = 20;
const FILIAIS_CACHE_TTL_MS = 60 * 60 * 1000;

export class TabletCloudClient {
  private http: AxiosInstance;
  private accessToken: string | null = null;
  private tokenObtainedAt = 0;
  private tokenTtlMs = 0;
  private filiaisCache: TabletCloudFilial[] | null = null;
  private filiaisCachedAt = 0;

  constructor() {
    this.http = axios.create({
      baseURL: config.tabletCloud.baseUrl,
      timeout: 30_000,
    });
  }

  // Fluxo OAuth2 password grant descrito em https://api.tabletcloud.com.br/Help
  private async login(): Promise<string> {
    const params = new URLSearchParams({
      username: config.tabletCloud.username,
      password: config.tabletCloud.password,
      grant_type: "password",
      client_id: config.tabletCloud.clientId,
      client_secret: config.tabletCloud.clientSecret,
    });

    const { data } = await axios.post<TokenResponse>(`${config.tabletCloud.baseUrl}/token`, params, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      timeout: 30_000,
    });

    this.accessToken = data.access_token;
    this.tokenObtainedAt = Date.now();
    // Margem de seguranca de 60s antes do vencimento real (padrao: 6h = 21599s)
    const expiresInSeconds = Number(data.expires_in) || 21599;
    this.tokenTtlMs = Math.max(expiresInSeconds - 60, 60) * 1000;
    logger.info("Novo access_token TabletCloud obtido");
    return this.accessToken;
  }

  private async getAccessToken(): Promise<string> {
    const expired = Date.now() - this.tokenObtainedAt > this.tokenTtlMs;
    if (!this.accessToken || expired) {
      await this.login();
    }
    return this.accessToken as string;
  }

  // Busca e filtra as filiais reais da conta (GET /filial/get), com cache de 1h.
  // Compartilhado por resolveFiliais() e getCnpjPorFilial() pra nao duplicar a chamada.
  private async fetchFiliais(): Promise<TabletCloudFilial[]> {
    const expired = Date.now() - this.filiaisCachedAt > FILIAIS_CACHE_TTL_MS;
    if (this.filiaisCache && !expired) {
      return this.filiaisCache;
    }

    const token = await this.getAccessToken();
    const { data } = await this.http.get<TabletCloudFilial[]>("/filial/get", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const filiais = (data ?? []).filter((f) => {
      const nome = (f.nome || "").toUpperCase();
      return !nome.includes("TABELA DE PRECO") && !nome.includes("MATRIZ SUPORTE");
    });

    this.filiaisCache = filiais;
    this.filiaisCachedAt = Date.now();
    logger.info({ total: filiais.length }, "Lista de filiais TabletCloud atualizada");
    return filiais;
  }

  /**
   * Resolve os codigos de filial a sincronizar: usa a lista fixa do .env se configurada,
   * senao busca todas as filiais da conta (GET /filial/get), com cache de 1h.
   */
  async resolveFiliais(): Promise<string[]> {
    if (config.tabletCloud.filiais.length > 0) {
      return config.tabletCloud.filiais;
    }
    const filiais = await this.fetchFiliais();
    return filiais.map((f) => String(f.codigo));
  }

  /**
   * Mapa codigo de filial (loja_id) -> CNPJ (so digitos), necessario porque a Polgo
   * exige `cnpjEmitente` (CNPJ real do estabelecimento) em vez do codigo interno.
   */
  async getCnpjPorFilial(): Promise<Map<string, string>> {
    const filiais = await this.fetchFiliais();
    const map = new Map<string, string>();
    for (const f of filiais) {
      const cnpjDigits = (f.cnpj ?? "").replace(/\D/g, "");
      if (cnpjDigits) map.set(String(f.codigo), cnpjDigits);
    }
    return map;
  }

  /**
   * Busca todos os cupons emitidos entre `from` e `to` (inclusive) para as filiais informadas.
   * Divide as filiais em lotes (a API/servidor nao suporta URLs com centenas de codigos)
   * e busca varios lotes em paralelo (config.tabletCloud.concurrency), cada um paginando
   * internamente ate esgotar. Sem paralelismo aqui, contas com muitas filiais nao caberiam
   * na janela do cron (busca e sequencial e a API so filtra por dia inteiro, nao por hora).
   *
   * Em vez de acumular todos os cupons do dia (todas as filiais) em memoria, cada pagina e
   * entregue via `onPage` assim que chega e so busca a proxima apos o processamento terminar
   * (backpressure). Isso mantem o uso de memoria limitado independente do volume total do dia
   * (essencial com centenas de milhares/milhoes de cupons na campanha inteira).
   */
  async getCuponsInRange(
    from: Date,
    to: Date,
    filiais: string[],
    onPage: (cupons: TabletCloudCupom[]) => Promise<void>
  ): Promise<{ totalFetched: number }> {
    const dataInicial = toDateOnly(from);
    const dataFinal = toDateOnly(to);

    const lotes: string[] = [];
    for (let i = 0; i < filiais.length; i += FILIAIS_POR_LOTE) {
      lotes.push(filiais.slice(i, i + FILIAIS_POR_LOTE).join(","));
    }

    let totalFetched = 0;
    let nextLoteIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const loteIndex = nextLoteIndex++;
        if (loteIndex >= lotes.length) return;
        const lote = lotes[loteIndex];
        logger.info({ lote: loteIndex + 1, totalLotes: lotes.length }, "Buscando cupons de um lote de filiais na TabletCloud");

        // Paginacao da TabletCloud e 1-indexada: offset=0 sempre vem vazio (total_on_this_page=0).
        let offset = 1;
        while (true) {
          const token = await this.getAccessToken();
          const url = `/cupom/get/${offset}/${dataInicial}/${dataFinal}/${lote}`;
          logger.debug({ url }, "Buscando cupons na TabletCloud");
          const { data } = await this.http.get<TabletCloudPage<TabletCloudCupom>>(url, {
            headers: { Authorization: `Bearer ${token}` },
          });

          const items = data?.data ?? [];
          logger.info(
            { lote: loteIndex + 1, offset, totalPages: data?.total_pages, totalRecords: data?.total_records },
            "Pagina de cupons recebida da TabletCloud"
          );
          if (items.length === 0) break;

          totalFetched += items.length;
          await onPage(items);
          if (data.current_page >= data.total_pages) break;
          offset += 1;
        }
      }
    };

    const workers = Array.from({ length: Math.min(config.tabletCloud.concurrency, lotes.length) }, () => worker());
    await Promise.all(workers);

    return { totalFetched };
  }
}

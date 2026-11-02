import axios, { AxiosInstance, AxiosError } from "axios";
import { config } from "../config";
import { logger } from "../logger";
import {
  PolgoApiEnvelope,
  PolgoDocumentoFiscalInsertPayload,
  PolgoDocumentoFiscalResponse,
} from "../types/polgo";

interface LoginRetorno {
  token: string;
}

// Lancado quando o chamador pediu pra desistir do envio antes dele ir pra rede (ex:
// circuit breaker do sync aberto enquanto o cupom esperava sua vez no rate limiter).
export class PolgoEnvioAdiadoError extends Error {
  constructor() {
    super("Envio a Polgo adiado: servico indisponivel neste ciclo");
  }
}

// Serializa chamadas para respeitar o limite de taxa da Polgo (recomendado: ate 2
// requisicoes/segundo). Diferente de um limite de concorrencia, isso garante o
// espacamento minimo entre requisicoes mesmo com varios workers em paralelo.
class RateLimiter {
  private chain: Promise<number> = Promise.resolve(0);

  constructor(private readonly minIntervalMs: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const myTurn = this.chain.then((lastCall) => {
      const now = Date.now();
      const runAt = Math.max(now, lastCall + this.minIntervalMs);
      return runAt;
    });
    this.chain = myTurn;
    const runAt = await myTurn;
    const wait = runAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return fn();
  }
}

export class PolgoClient {
  private http: AxiosInstance;
  private token: string | null = null;
  private tokenObtainedAt = 0;
  // Polgo confirmou token de integracao com validade de 6 meses; renovamos de forma
  // preventiva bem antes disso so pra reduzir a chance de usar um token perto do fim
  // da janela, mas o retry reativo em 401 cobre qualquer expiracao inesperada.
  private readonly tokenTtlMs = 24 * 60 * 60 * 1000;
  // Polgo recomenda ate 2 requisicoes/segundo (confirmado por eles: envios
  // simultaneos do mesmo numeroDocumento no mesmo segundo geram 429).
  private readonly rateLimiter = new RateLimiter(500);

  constructor() {
    this.http = axios.create({
      baseURL: config.polgo.baseUrl,
      timeout: 30_000,
    });
  }

  private async login(): Promise<string> {
    const { data } = await this.http.post<PolgoApiEnvelope<LoginRetorno>>(
      "/login/v1/autenticacao",
      {
        usuario: config.polgo.usuario,
        senha: config.polgo.senha,
      }
    );
    this.token = data.retorno.token;
    this.tokenObtainedAt = Date.now();
    logger.info("Novo token Polgo obtido");
    return this.token;
  }

  private async getToken(): Promise<string> {
    const expired = Date.now() - this.tokenObtainedAt > this.tokenTtlMs;
    if (!this.token || expired) {
      await this.login();
    }
    return this.token as string;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { Authorization: token };
  }

  /**
   * Envia uma nova venda para a Polgo assimilar ao sorteio da campanha configurada.
   * `deveAdiar` e' consultado logo antes da requisicao sair (ja dentro do rate limiter);
   * se retornar true, lanca PolgoEnvioAdiadoError sem tocar na rede.
   */
  async inserirDocumentoFiscal(
    payload: PolgoDocumentoFiscalInsertPayload,
    deveAdiar: () => boolean = () => false
  ): Promise<PolgoDocumentoFiscalResponse> {
    if (deveAdiar()) throw new PolgoEnvioAdiadoError();
    return this.rateLimiter.run(() => {
      if (deveAdiar()) throw new PolgoEnvioAdiadoError();
      return this.withAuthRetry(async () => {
        const headers = await this.authHeaders();
        const { data } = await this.http.post<PolgoApiEnvelope<PolgoDocumentoFiscalResponse>>(
          "/documentoFiscal/v1/inserir",
          payload,
          // Menor que o timeout padrao do client: com a Polgo degradada, cada envio
          // pendente segura o ciclo inteiro por esse tempo (ver circuit breaker no sync).
          // Saudavel, a Polgo responde em bem menos de 1s.
          { headers, timeout: 10_000 }
        );
        return data.retorno;
      });
    });
  }

  /** Cancela uma venda ja enviada (ex: estorno detectado no PDV). */
  async cancelarDocumentoFiscal(idDocumentoFiscal: string): Promise<void> {
    await this.rateLimiter.run(() =>
      this.withAuthRetry(async () => {
        const headers = await this.authHeaders();
        await this.http.post("/documentoFiscal/v1/documentos/cancelar", { idDocumentoFiscal }, { headers });
      })
    );
  }

  /** Busca documentos ja gravados na Polgo (usado pra confirmar que um envio realmente persistiu). */
  async listarDocumentosFiscais(filtros: Record<string, string>, totalPorPagina = 20, pagina = 1): Promise<unknown> {
    return this.rateLimiter.run(() =>
      this.withAuthRetry(async () => {
        const headers = await this.authHeaders();
        const { data } = await this.http.get<PolgoApiEnvelope<unknown>>(
          `/documentoFiscal/v1/documentos/${totalPorPagina}/${pagina}`,
          { headers, params: filtros }
        );
        return data.retorno;
      })
    );
  }

  private async withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const axiosErr = err as AxiosError;
      if (axiosErr.response?.status === 401) {
        logger.warn("Token Polgo invalido/expirado, tentando reautenticar");
        this.token = null;
        return fn();
      }
      // Polgo confirmou: duas requisicoes com o mesmo numeroDocumento no mesmo
      // segundo resultam em 429 na segunda. Aguarda um pouco e tenta de novo uma vez.
      if (axiosErr.response?.status === 429) {
        logger.warn("Polgo retornou 429 (rate limit), tentando novamente em 1s");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return fn();
      }
      throw err;
    }
  }
}

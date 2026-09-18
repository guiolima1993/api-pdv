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

export class PolgoClient {
  private http: AxiosInstance;
  private token: string | null = null;
  private tokenObtainedAt = 0;
  // Renova preventivamente antes do JWT expirar; a Polgo nao documenta TTL exato.
  private readonly tokenTtlMs = 50 * 60 * 1000;

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

  /** Envia uma nova venda para a Polgo assimilar ao sorteio da campanha configurada. */
  async inserirDocumentoFiscal(
    payload: PolgoDocumentoFiscalInsertPayload
  ): Promise<PolgoDocumentoFiscalResponse> {
    return this.withAuthRetry(async () => {
      const headers = await this.authHeaders();
      const { data } = await this.http.post<PolgoApiEnvelope<PolgoDocumentoFiscalResponse>>(
        "/documentoFiscal/v1/inserir",
        payload,
        { headers }
      );
      return data.retorno;
    });
  }

  /** Cancela uma venda ja enviada (ex: estorno detectado no PDV). */
  async cancelarDocumentoFiscal(idDocumentoFiscal: string): Promise<void> {
    await this.withAuthRetry(async () => {
      const headers = await this.authHeaders();
      await this.http.post("/documentoFiscal/v1/documentos/cancelar", { idDocumentoFiscal }, { headers });
    });
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
      throw err;
    }
  }
}

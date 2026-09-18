import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import { logger } from "../logger";
import { TabletCloudCupom } from "../types/tabletCloud";
import { toDateOnly } from "../utils/dateUtils";

const PAGE_SIZE = 100;

export class TabletCloudClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.tabletCloud.baseUrl,
      timeout: 30_000,
      headers: {
        [config.tabletCloud.authHeader]: config.tabletCloud.authScheme
          ? `${config.tabletCloud.authScheme} ${config.tabletCloud.token}`
          : config.tabletCloud.token,
      },
    });
  }

  /**
   * Busca todos os cupons emitidos entre `from` e `to` (inclusive) para as filiais configuradas.
   * Pagina automaticamente pois a API devolve no maximo 100 registros por chamada.
   */
  async getCuponsInRange(from: Date, to: Date): Promise<TabletCloudCupom[]> {
    const dataInicial = toDateOnly(from);
    const dataFinal = toDateOnly(to);
    const filiais = config.tabletCloud.filiais.join(",");

    const results: TabletCloudCupom[] = [];
    let offset = 0;

    while (true) {
      const url = `/cupom/get/${offset}/${dataInicial}/${dataFinal}/${filiais}`;
      logger.debug({ url }, "Buscando cupons na TabletCloud");
      const { data } = await this.http.get<TabletCloudCupom[]>(url);

      if (!Array.isArray(data) || data.length === 0) break;

      results.push(...data);
      if (data.length < PAGE_SIZE) break;
      offset += 1;
    }

    return results;
  }
}

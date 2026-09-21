import axios from "axios";
import { config } from "../config";
import { logger } from "../logger";

// Debug cru: chama a API diretamente e mostra a resposta completa (sem passar pelo client/mapeamento).
async function main(): Promise<void> {
  const params = new URLSearchParams({
    username: config.tabletCloud.username,
    password: config.tabletCloud.password,
    grant_type: "password",
    client_id: config.tabletCloud.clientId,
    client_secret: config.tabletCloud.clientSecret,
  });

  const { data: token } = await axios.post(`${config.tabletCloud.baseUrl}/token`, params, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  logger.info({ token }, "Token obtido");

  const { data: filiaisRaw } = await axios.get(`${config.tabletCloud.baseUrl}/filial/get`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  logger.info({ total: filiaisRaw.length, primeiras: filiaisRaw.slice(0, 5) }, "Filiais cruas (sem filtro)");

  // Testa um intervalo de 10 dias com as primeiras 20 filiais cruas, sem nenhum filtro do nosso lado.
  const codigos = filiaisRaw.slice(0, 20).map((f: { codigo: number }) => f.codigo).join(",");
  const dataFinal = new Date().toISOString().slice(0, 10);
  const dataInicial = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const offset of [0, 1]) {
    const url = `${config.tabletCloud.baseUrl}/cupom/get/${offset}/${dataInicial}/${dataFinal}/${codigos}`;
    logger.info({ url }, "Chamando cupom/get diretamente");
    const { data: cupons } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    logger.info(
      {
        offset,
        total_records: cupons.total_records,
        total_pages: cupons.total_pages,
        total_on_this_page: cupons.total_on_this_page,
        current_page: cupons.current_page,
        primeiroCupom: cupons.data?.[0],
      },
      "Resposta crua de cupom/get",
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: err?.response?.data ?? err }, "Debug falhou");
    process.exit(1);
  });

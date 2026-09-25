import { AxiosError } from "axios";

// Loga erros de chamadas HTTP sem incluir o objeto inteiro do axios: o objeto completo
// carrega `config`/`request` com os headers da requisicao (incluindo Authorization com
// o token), o que vazaria credenciais em texto plano nos logs.
export function describeHttpError(err: unknown): Record<string, unknown> {
  const axiosErr = err as AxiosError;
  if (axiosErr?.isAxiosError) {
    return {
      message: axiosErr.message,
      status: axiosErr.response?.status,
      data: axiosErr.response?.data,
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

// Fuso fixo da operacao (Brasil), independente do TZ do host onde o processo roda -
// evita que a data usada para consultar a TabletCloud fique deslocada em 1 dia.
const TZ = "America/Sao_Paulo";

/** Formata YYYY-MM-DD no fuso America/Sao_Paulo (formato aceito pela TabletCloud para date). */
export function toDateOnly(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    d
  );
}

/**
 * Converte o `dtmovimento`/`dtabertura`/etc. da TabletCloud (ex.: "2026-09-25T00:00:00")
 * para o formato "YYYY-MM-DD HH:mm:ss" exigido pela Polgo, SEM passar por `new Date()`.
 * Esses campos vem sem offset de timezone mas ja representam o horario local
 * (America/Sao_Paulo); `new Date(str)` interpretaria como horario local do PROCESSO
 * (UTC na Hostinger) e uma reconversao de TZ deslocaria a data em -3h, empurrando
 * vendas de madrugada pro dia anterior (rejeitadas pela Polgo como "fora do prazo").
 */
export function formatTabletCloudDateTime(raw: string): string {
  return raw.replace("T", " ").slice(0, 19);
}

/**
 * Divide um intervalo [start, end] em blocos de no maximo `maxDays` dias,
 * pois a TabletCloud limita cupom/get a um intervalo maximo de 10 dias.
 */
export function chunkDateRange(start: Date, end: Date, maxDays = 9): Array<{ from: Date; to: Date }> {
  const chunks: Array<{ from: Date; to: Date }> = [];
  let cursor = new Date(start);

  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays);
    const to = chunkEnd > end ? end : chunkEnd;
    chunks.push({ from: new Date(cursor), to: new Date(to) });
    cursor = new Date(to);
    cursor.setDate(cursor.getDate() + 1);
  }

  return chunks;
}

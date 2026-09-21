// Fuso fixo da operacao (Brasil), independente do TZ do host onde o processo roda -
// evita que a data usada para consultar a TabletCloud fique deslocada em 1 dia.
const TZ = "America/Sao_Paulo";

/** Formata YYYY-MM-DD no fuso America/Sao_Paulo (formato aceito pela TabletCloud para date). */
export function toDateOnly(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    d
  );
}

/** Formata YYYY-MM-DD HH:mm:ss no fuso America/Sao_Paulo (formato aceito pela Polgo). */
export function toDateTime(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23", // hour12:false sofre de um bug do ICU que retorna "24" em vez de "00" a meia-noite
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
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

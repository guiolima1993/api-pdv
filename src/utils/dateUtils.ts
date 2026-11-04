// Fuso fixo da operacao (Brasil), independente do TZ do host onde o processo roda -
// evita que a data usada para consultar a TabletCloud fique deslocada em 1 dia.
const TZ = "America/Sao_Paulo";

/** Formata YYYY-MM-DD no fuso America/Sao_Paulo (formato aceito pela TabletCloud para date). */
export function toDateOnly(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    d
  );
}

export function parseDateOnly(raw: string): Date {
  const date = new Date(`${raw}T00:00:00-03:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(date.getTime()) || toDateOnly(date) !== raw) {
    throw new Error("Data invalida: informe um dia existente no formato YYYY-MM-DD");
  }
  return date;
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
  if (!Number.isSafeInteger(maxDays) || maxDays < 0) throw new Error("maxDays deve ser inteiro nao negativo");
  const chunks: Array<{ from: Date; to: Date }> = [];
  if (start > end) return chunks;
  let cursor = parseDateOnly(toDateOnly(start));
  const lastDay = parseDateOnly(toDateOnly(end));

  // A API filtra dias, nao horas. Preservar a hora do cursor pode pular o ultimo
  // dia quando ele tem um horario menor que o inicio do bloco seguinte.
  while (cursor <= lastDay) {
    const chunkEnd = new Date(cursor.getTime() + maxDays * 24 * 60 * 60 * 1000);
    const to = chunkEnd > lastDay ? lastDay : chunkEnd;
    chunks.push({ from: new Date(cursor), to: new Date(to) });
    cursor = new Date(to.getTime() + 24 * 60 * 60 * 1000);
  }

  return chunks;
}

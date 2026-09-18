function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Formata YYYY-MM-DD (formato aceito pela TabletCloud para date). */
export function toDateOnly(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Formata YYYY-MM-DD HH:mm:ss (formato aceito pela Polgo). */
export function toDateTime(d: Date): string {
  return `${toDateOnly(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { logger } from "./logger";

// Armazenamento em arquivo local (sem dependencias nativas) para funcionar em
// hospedagens compartilhadas que nao conseguem compilar modulos como better-sqlite3.
//
// Formato: log append-only (1 linha JSON por alteracao), nao um snapshot unico.
// Isso e o que permite escalar pra centenas de milhares/milhoes de cupons: cada
// upsert vira so uma linha nova (O(1)), em vez de reescrever o arquivo inteiro
// (O(n), o que ficaria inviavel nesse volume). O arquivo e compactado (reduzido
// a 1 linha por chave) periodicamente para nao crescer sem limite.
const dbDir = path.dirname(config.database.file);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const logFile = config.database.file;

export type CupomStatus = "pending" | "sent" | "skipped" | "canceled" | "error";

export interface SyncedCupomRow {
  venda_id: number;
  cod_filial: number;
  status: CupomStatus;
  polgo_document_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

type LogEntry = { type: "cupom"; row: SyncedCupomRow } | { type: "state"; key: string; value: string };

interface Store {
  cupons: Record<string, SyncedCupomRow>;
  state: Record<string, string>;
}

const store: Store = { cupons: {}, state: {} };
let linesSinceCompaction = 0;

function cupomKey(vendaId: number, codFilial: number): string {
  return `${vendaId}:${codFilial}`;
}

function applyEntry(entry: LogEntry): void {
  if (entry.type === "cupom") {
    store.cupons[cupomKey(entry.row.venda_id, entry.row.cod_filial)] = entry.row;
  } else {
    store.state[entry.key] = entry.value;
  }
}

// Compativel com o formato antigo (um unico objeto {cupons,state}) usado antes desta
// migracao, para nao perder dados ja gravados em producao.
function tryLoadLegacySnapshot(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Partial<Store>;
    if (!parsed || typeof parsed !== "object" || !("cupons" in parsed)) return false;
    for (const row of Object.values(parsed.cupons ?? {})) applyEntry({ type: "cupom", row });
    for (const [key, value] of Object.entries(parsed.state ?? {})) applyEntry({ type: "state", key, value });
    return true;
  } catch {
    return false;
  }
}

function loadStore(): void {
  if (!fs.existsSync(logFile)) return;
  const raw = fs.readFileSync(logFile, "utf-8");
  if (!raw.trim()) return;

  if (tryLoadLegacySnapshot(raw)) {
    linesSinceCompaction = Object.keys(store.cupons).length + Object.keys(store.state).length;
    return;
  }

  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line) continue;
    try {
      applyEntry(JSON.parse(line) as LogEntry);
    } catch {
      // linha corrompida (processo encerrado no meio de uma escrita) - ignora e segue
    }
  }
  linesSinceCompaction = lines.length;
}

loadStore();

let pendingLines: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_INTERVAL_MS = 1000;
// So compacta quando o log crescer bem mais que o numero de chaves unicas, entao o
// custo O(n) da compactacao e raro (nao acontece a cada upsert).
const COMPACTION_THRESHOLD_MULTIPLIER = 3;

function scheduleFlush(): void {
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref();
  }
}

function appendEntry(entry: LogEntry): void {
  applyEntry(entry);
  pendingLines.push(JSON.stringify(entry));
  linesSinceCompaction += 1;
  scheduleFlush();
}

function compactIfNeeded(): void {
  const uniqueKeys = Object.keys(store.cupons).length + Object.keys(store.state).length;
  if (linesSinceCompaction < uniqueKeys * COMPACTION_THRESHOLD_MULTIPLIER) return;

  const lines: string[] = [];
  for (const row of Object.values(store.cupons)) lines.push(JSON.stringify({ type: "cupom", row } as LogEntry));
  for (const [key, value] of Object.entries(store.state)) {
    lines.push(JSON.stringify({ type: "state", key, value } as LogEntry));
  }
  // Nome unico por processo: evita colisao quando duas instancias (ex: durante um
  // deploy, a antiga ainda encerrando e a nova ja no ar) compactam ao mesmo tempo.
  const tmpFile = `${logFile}.compact.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpFile, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf-8");
    fs.renameSync(tmpFile, logFile);
    linesSinceCompaction = lines.length;
  } catch (err) {
    // Compactacao e apenas uma otimizacao de espaco; se falhar (ex: outra instancia
    // mexeu no arquivo ao mesmo tempo), so tenta de novo no proximo ciclo.
    logger.warn({ err: String(err) }, "Falha ao compactar sync.db, tentando novamente depois");
  }
}

// Forca a gravacao imediata do lote pendente (fim de ciclo de sync, encerramento do processo, etc).
export function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingLines.length > 0) {
    fs.appendFileSync(logFile, pendingLines.join("\n") + "\n", "utf-8");
    pendingLines = [];
  }
  compactIfNeeded();
}

process.on("beforeExit", flush);
process.on("SIGTERM", () => {
  flush();
  process.exit(0);
});
process.on("SIGINT", () => {
  flush();
  process.exit(0);
});

export function getSyncedCupom(vendaId: number, codFilial: number): SyncedCupomRow | undefined {
  return store.cupons[cupomKey(vendaId, codFilial)];
}

export function upsertSyncedCupom(row: {
  venda_id: number;
  cod_filial: number;
  status: CupomStatus;
  polgo_document_id?: string | null;
  attempts?: number;
  last_error?: string | null;
}): void {
  const now = new Date().toISOString();
  const key = cupomKey(row.venda_id, row.cod_filial);
  const existing = store.cupons[key];
  const newRow: SyncedCupomRow = {
    venda_id: row.venda_id,
    cod_filial: row.cod_filial,
    status: row.status,
    polgo_document_id: row.polgo_document_id ?? existing?.polgo_document_id ?? null,
    attempts: row.attempts ?? 0,
    last_error: row.last_error ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  appendEntry({ type: "cupom", row: newRow });
}

export function countByStatus(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of Object.values(store.cupons)) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}

export function getSyncCursor(): string | undefined {
  return store.state["last_synced_at"];
}

export function setSyncCursor(isoDate: string): void {
  appendEntry({ type: "state", key: "last_synced_at", value: isoDate });
}

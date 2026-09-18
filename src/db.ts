import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

const dbDir = path.dirname(config.database.file);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(config.database.file);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS synced_cupons (
    venda_id INTEGER NOT NULL,
    cod_filial INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | skipped | canceled | error
    polgo_document_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (venda_id, cod_filial)
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

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

export function getSyncedCupom(vendaId: number, codFilial: number): SyncedCupomRow | undefined {
  return db
    .prepare(`SELECT * FROM synced_cupons WHERE venda_id = ? AND cod_filial = ?`)
    .get(vendaId, codFilial) as SyncedCupomRow | undefined;
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
  db.prepare(
    `INSERT INTO synced_cupons (venda_id, cod_filial, status, polgo_document_id, attempts, last_error, created_at, updated_at)
     VALUES (@venda_id, @cod_filial, @status, @polgo_document_id, @attempts, @last_error, @created_at, @updated_at)
     ON CONFLICT(venda_id, cod_filial) DO UPDATE SET
       status = excluded.status,
       polgo_document_id = COALESCE(excluded.polgo_document_id, synced_cupons.polgo_document_id),
       attempts = excluded.attempts,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`
  ).run({
    venda_id: row.venda_id,
    cod_filial: row.cod_filial,
    status: row.status,
    polgo_document_id: row.polgo_document_id ?? null,
    attempts: row.attempts ?? 0,
    last_error: row.last_error ?? null,
    created_at: now,
    updated_at: now,
  });
}

export function countByStatus(): Record<string, number> {
  const rows = db
    .prepare(`SELECT status, COUNT(*) as total FROM synced_cupons GROUP BY status`)
    .all() as { status: string; total: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.total]));
}

export function getSyncCursor(): string | undefined {
  const row = db.prepare(`SELECT value FROM sync_state WHERE key = 'last_synced_at'`).get() as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSyncCursor(isoDate: string): void {
  db.prepare(
    `INSERT INTO sync_state (key, value) VALUES ('last_synced_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(isoDate);
}

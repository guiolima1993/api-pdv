import mysql from "mysql2/promise";
import { config } from "./config";

// Estado do sync (cursor + status de cada cupom) em MySQL: hospedagens gerenciadas
// tipo a Hostinger nao persistem disco local entre deploys, entao guardar isso em
// arquivo local (como era antes) perde tudo a cada redeploy.

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

const pool = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  waitForConnections: true,
  // Acompanha o SYNC_CONCURRENCY (processamento paralelo de cupons) para nao virar
  // o novo gargalo quando o volume de vendas aumentar.
  connectionLimit: 25,
});

let readyPromise: Promise<void> | null = null;

// Cria as tabelas se ainda nao existirem. Chamado uma vez no startup (index.ts/runOnce.ts)
// antes de qualquer outra funcao deste modulo ser usada.
export function init(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS synced_cupons (
          venda_id BIGINT NOT NULL,
          cod_filial BIGINT NOT NULL,
          status VARCHAR(20) NOT NULL,
          polgo_document_id VARCHAR(100) NULL,
          attempts INT NOT NULL DEFAULT 0,
          last_error TEXT NULL,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          PRIMARY KEY (venda_id, cod_filial),
          INDEX idx_status (status)
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sync_state (
          \`key\` VARCHAR(100) NOT NULL PRIMARY KEY,
          value VARCHAR(255) NOT NULL
        )
      `);
    })();
  }
  return readyPromise;
}

export async function getSyncedCupom(vendaId: number, codFilial: number): Promise<SyncedCupomRow | undefined> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM synced_cupons WHERE venda_id = ? AND cod_filial = ?",
    [vendaId, codFilial]
  );
  return rows[0] as SyncedCupomRow | undefined;
}

export async function upsertSyncedCupom(row: {
  venda_id: number;
  cod_filial: number;
  status: CupomStatus;
  polgo_document_id?: string | null;
  attempts?: number;
  last_error?: string | null;
}): Promise<void> {
  const now = new Date();
  await pool.query(
    `INSERT INTO synced_cupons
       (venda_id, cod_filial, status, polgo_document_id, attempts, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       polgo_document_id = COALESCE(VALUES(polgo_document_id), polgo_document_id),
       attempts = VALUES(attempts),
       last_error = VALUES(last_error),
       updated_at = VALUES(updated_at)`,
    [
      row.venda_id,
      row.cod_filial,
      row.status,
      row.polgo_document_id ?? null,
      row.attempts ?? 0,
      row.last_error ?? null,
      now,
      now,
    ]
  );
}

export async function countByStatus(): Promise<Record<string, number>> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT status, COUNT(*) as total FROM synced_cupons GROUP BY status"
  );
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status as string] = Number(row.total);
  return counts;
}

export async function listByStatus(status: CupomStatus, limit = 20): Promise<SyncedCupomRow[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM synced_cupons WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
    [status, limit]
  );
  return rows as SyncedCupomRow[];
}

export async function getSyncCursor(): Promise<string | undefined> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT value FROM sync_state WHERE `key` = 'last_synced_at'"
  );
  return rows[0]?.value as string | undefined;
}

export async function setSyncCursor(isoDate: string): Promise<void> {
  await pool.query(
    "INSERT INTO sync_state (`key`, value) VALUES ('last_synced_at', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
    [isoDate]
  );
}

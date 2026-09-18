import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

// Armazenamento em arquivo JSON puro (sem dependencias nativas) para funcionar
// em hospedagens compartilhadas que nao conseguem compilar modulos como better-sqlite3.
const dbDir = path.dirname(config.database.file);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const storeFile = config.database.file;

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

interface Store {
  cupons: Record<string, SyncedCupomRow>;
  state: Record<string, string>;
}

function loadStore(): Store {
  if (fs.existsSync(storeFile)) {
    try {
      const raw = fs.readFileSync(storeFile, "utf-8");
      const parsed = JSON.parse(raw) as Partial<Store>;
      return { cupons: parsed.cupons ?? {}, state: parsed.state ?? {} };
    } catch {
      return { cupons: {}, state: {} };
    }
  }
  return { cupons: {}, state: {} };
}

const store: Store = loadStore();

function persist(): void {
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), "utf-8");
}

function cupomKey(vendaId: number, codFilial: number): string {
  return `${vendaId}:${codFilial}`;
}

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
  store.cupons[key] = {
    venda_id: row.venda_id,
    cod_filial: row.cod_filial,
    status: row.status,
    polgo_document_id: row.polgo_document_id ?? existing?.polgo_document_id ?? null,
    attempts: row.attempts ?? 0,
    last_error: row.last_error ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  persist();
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
  store.state["last_synced_at"] = isoDate;
  persist();
}

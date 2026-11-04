const assert = require("node:assert/strict");
const { test, beforeEach, mock } = require("node:test");

process.env.DOTENV_CONFIG_PATH = "/dev/null";
Object.assign(process.env, {
  TABLETCLOUD_USERNAME: "test", TABLETCLOUD_PASSWORD: "test",
  TABLETCLOUD_CLIENT_ID: "test", TABLETCLOUD_CLIENT_SECRET: "test",
  POLGO_USUARIO: "test", POLGO_SENHA: "test", POLGO_CAMPANHA_IDENTIFICACAO: "TEST",
  POLGO_CAMPANHA_INICIO: "2026-09-25", POLGO_CAMPANHA_FIM: "2026-11-30",
  DB_NAME: "test", DB_USER: "test", DB_PASSWORD: "test",
  LOG_LEVEL: "silent", NODE_ENV: "production", SYNC_EDIT_LOOKBACK_MINUTES: "60",
});

const fakePool = { getConnection: async () => { throw new Error("Unexpected database connection"); } };
mock.method(require("mysql2/promise"), "createPool", () => fakePool);
const db = require("../dist/db");
const realWithSyncLock = db.withSyncLock;
const { config } = require("../dist/config");
const { TabletCloudClient } = require("../dist/clients/tabletCloudClient");
const realGetCupom = TabletCloudClient.prototype.getCupom;
const { PolgoClient } = require("../dist/clients/polgoClient");
const { runSync, isCancelled } = require("../dist/services/syncService");
const { parseCuponsEditados, recuperarCuponsEditados } = require("../dist/services/recoveryService");
const {
  getCpfConsumidor, mapCupomToDocumentoFiscal, UnidentifiedConsumerError,
  SEM_CPF_MARKER, FORA_DA_JANELA_LOCAL_MARKER,
} = require("../dist/mappers/cupomToDocumentoFiscal");
const { toDateOnly, parseDateOnly, chunkDateRange } = require("../dist/utils/dateUtils");

const CPF = "01234567890"; // Synthetic test data.
const CNPJ = "12345678000199";
const dayRange = { from: parseDateOnly("2026-11-02"), to: parseDateOnly("2026-11-02") };
const cupom = (overrides = {}) => ({
  venda_id: 101, loja_id: 10, valortotal: 100.5, dtmovimento: "2026-11-02T12:38:48",
  clientes: [], itens: [{ codproduto: 1, nomeProduto: "Item", quantidade: 1, valortotal: 100.5 }],
  notas: [{ nnf: 1234, chave_acesso: "nota-teste", doc_emitido: true, status_sefaz: "100", docCliente: "" }],
  ...overrides,
});
const correcao = (overrides = {}) => ({
  vendaId: 101, filial: 10, dataVenda: "2026-11-02", numeroNota: 1234, valorTotal: 100.5, cpf: CPF,
  ...overrides,
});
const key = (id, filial) => `${filial}:${id}`;
let rows, cupons, sent, canceled, ranges, cursorWrites, locks;
function seed(status = "skipped", last_error = SEM_CPF_MARKER, extra = {}) {
  rows.set(key(101, 10), {
    venda_id: 101, cod_filial: 10, status, last_error,
    polgo_document_id: null, attempts: 0, ...extra,
  });
}

beforeEach((t) => {
  rows = new Map();
  cupons = [cupom()];
  sent = [];
  canceled = [];
  ranges = [];
  cursorWrites = [];
  locks = 0;
  config.polgo.campanha.inicio = "2026-09-25";
  config.polgo.campanha.fim = "2026-11-30";
  config.sync.initialLookbackDays = 0;
  t.mock.method(db, "withSyncLock", async (work) => { locks++; return work(); });
  t.mock.method(db, "getSyncedCupom", async (id, filial) => rows.get(key(id, filial)));
  t.mock.method(db, "upsertSyncedCupom", async (row) => {
    const old = rows.get(key(row.venda_id, row.cod_filial));
    rows.set(key(row.venda_id, row.cod_filial), {
      ...old, ...row, attempts: row.attempts ?? 0, last_error: row.last_error ?? null,
      polgo_document_id: row.polgo_document_id ?? old?.polgo_document_id ?? null,
    });
  });
  t.mock.method(db, "getSyncCursor", async () => "2026-11-03T03:02:00.000Z");
  t.mock.method(db, "setSyncCursor", async (cursor) => { cursorWrites.push(cursor); });
  t.mock.method(TabletCloudClient.prototype, "resolveFiliais", async () => ["10", "20"]);
  t.mock.method(TabletCloudClient.prototype, "getCnpjPorFilial", async () => new Map([["10", CNPJ], ["20", CNPJ]]));
  t.mock.method(TabletCloudClient.prototype, "getCupom", async (id, filial) => {
    const found = cupons.find((c) => c.venda_id === id && c.loja_id === filial);
    if (!found) throw new Error("Cupom nao encontrado");
    return found;
  });
  t.mock.method(TabletCloudClient.prototype, "getCuponsInRange", async (from, to, filiais, onPage) => {
    ranges.push({ from, to, filiais });
    await onPage(cupons);
    return { totalFetched: cupons.length };
  });
  t.mock.method(PolgoClient.prototype, "inserirDocumentoFiscal", async (payload) => {
    sent.push(payload);
    return { id: `polgo-${sent.length}` };
  });
  t.mock.method(PolgoClient.prototype, "cancelarDocumentoFiscal", async (id) => { canceled.push(id); });
});

test("missing CPF becomes eligible after edit and is sent only once", async () => {
  assert.equal((await runSync(dayRange)).skipped, 1);
  assert.match(rows.get(key(101, 10)).last_error, /sem CPF de pessoa fisica/);
  cupons[0].clientes = [{ cod: 1, cpf_cnpj: "012.345.678-90" }];
  assert.equal((await runSync(dayRange)).sent, 1);
  assert.equal((await runSync(dayRange)).sent, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].usuario, CPF);
  assert.equal(sent[0].numeroDocumento, "nota-teste");
  assert.equal(rows.get(key(101, 10)).status, "sent");
});

test("legacy missing CPF records recover from notas.docCliente, not just clientes", async () => {
  seed("skipped", `Venda 101 (filial 10) ${SEM_CPF_MARKER} - nao pode ser enviada a Polgo`);
  cupons[0].notas[0].docCliente = CPF;
  assert.equal((await runSync(dayRange)).sent, 1);
  assert.equal(sent[0].cnpjCpf, CPF);
});

test("empty CPF and company identifiers remain unsent", async () => {
  seed();
  cupons[0].clientes = [{ cod: 1, cpf_cnpj: CNPJ }];
  cupons[0].notas[0].docCliente = CNPJ;
  assert.equal((await runSync(dayRange)).sent, 0);
  assert.equal(sent.length, 0);
  assert.throws(() => mapCupomToDocumentoFiscal(cupons[0], CNPJ), UnidentifiedConsumerError);
});

test("canceled clients and canceled, unauthorized or unissued fiscal notes supply no CPF", () => {
  for (const overrides of [{ cancelado: true }, { doc_emitido: false }, { status_sefaz: "101" }]) {
    const c = cupom({ clientes: [{ cod: 1, cpf_cnpj: CPF, cancelado: true }] });
    c.notas[0] = { ...c.notas[0], docCliente: CPF, ...overrides };
    assert.equal(getCpfConsumidor(c), undefined);
  }
});

test("active client takes precedence and canceled note does not replace the valid key", () => {
  const c = cupom({ clientes: [{ cod: 1, cpf_cnpj: CPF }] });
  c.notas[0].docCliente = "98765432100";
  c.notas.unshift({ chave_acesso: "cancelada", cancelado: true, doc_emitido: true });
  const payload = mapCupomToDocumentoFiscal(c, CNPJ);
  assert.equal(payload.usuario, CPF);
  assert.equal(payload.numeroDocumento, "nota-teste");
});

test("fiscal CPF fallback uses the key of the same note", () => {
  const c = cupom();
  c.notas.push({ ...c.notas[0], chave_acesso: "nota-com-cpf", nnf: 1235, docCliente: CPF });
  const payload = mapCupomToDocumentoFiscal(c, CNPJ);
  assert.equal(payload.usuario, CPF);
  assert.equal(payload.numeroDocumento, "nota-com-cpf");
});

test("campaign and real cancellation checks still apply after adding CPF", async () => {
  seed();
  cupons[0].clientes = [{ cod: 1, cpf_cnpj: CPF }];
  config.polgo.campanha.fim = "2026-10-31";
  assert.equal((await runSync(dayRange)).sent, 0);
  assert.match(rows.get(key(101, 10)).last_error, /fora da janela da campanha/);
  config.polgo.campanha.fim = "2026-11-30";
  cupons[0].isestornado = true;
  assert.equal((await runSync(dayRange)).sent, 0);
  assert.equal(sent.length, 0);
});

test("campaign extension and nonterminal API errors retain their existing retry behavior", async () => {
  for (const [status, reason] of [["skipped", FORA_DA_JANELA_LOCAL_MARKER], ["error", "timeout"]]) {
    seed(status, reason);
    cupons[0].clientes = [{ cod: 1, cpf_cnpj: CPF }];
    assert.equal((await runSync(dayRange)).sent, 1);
  }
});

test("already-sent CPF edits do not resend; reversal still cancels in Polgo", async () => {
  seed("sent", null, { polgo_document_id: "polgo-existing" });
  cupons[0].clientes = [{ cod: 1, cpf_cnpj: CPF }];
  assert.equal((await runSync(dayRange)).sent, 0);
  cupons[0].isestornado = true;
  assert.equal((await runSync(dayRange)).canceled, 1);
  assert.deepEqual(canceled, ["polgo-existing"]);
  assert.equal(sent.length, 0);
  assert.equal(isCancelled(cupom({ iscancelado: true })), false);
});

test("five-minute edit crossing midnight is searched and sent in the next cycle", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-03T03:06:00.000Z") });
  seed();
  cupons[0].dtmovimento = "2026-11-02T23:59:00";
  cupons[0].clientes = [{ cod: 1, cpf_cnpj: CPF }];
  assert.equal((await runSync()).sent, 1);
  assert.equal(toDateOnly(ranges[0].from), "2026-11-02");
  assert.equal(toDateOnly(ranges[0].to), "2026-11-03");
  assert.deepEqual(cursorWrites, ["2026-11-03T03:06:00.000Z"]);
  assert.equal(locks, 1);
});

test("historical Nov 2 replay leaves the live cursor untouched", async () => {
  seed();
  cupons[0].clientes = [{ cod: 1, cpf_cnpj: CPF }];
  assert.equal((await runSync(dayRange)).sent, 1);
  assert.equal(toDateOnly(ranges[0].from), "2026-11-02");
  assert.equal(toDateOnly(ranges[0].to), "2026-11-02");
  assert.equal(db.getSyncCursor.mock.callCount(), 0);
  assert.deepEqual(cursorWrites, []);
  assert.equal(sent[0].dataHoraEmissao, "2026-11-02 12:38:48");
});

test("invalid date ranges fail before locking or calling any API", async () => {
  await assert.rejects(runSync({ from: new Date("invalid"), to: new Date() }), /Intervalo/);
  await assert.rejects(runSync({ from: parseDateOnly("2026-11-03"), to: parseDateOnly("2026-11-02") }), /Intervalo/);
  assert.equal(locks, 0);
  assert.throws(() => parseDateOnly("2026-02-30"), /Data invalida/);
  assert.throws(() => parseDateOnly("02/11/2026"), /Data invalida/);
});

test("day chunks have no gaps when final day has an earlier time", () => {
  const chunks = chunkDateRange(new Date("2026-11-01T23:50:00-03:00"), new Date("2026-11-11T00:05:00-03:00"));
  assert.deepEqual(chunks.map(({ from, to }) => [toDateOnly(from), toDateOnly(to)]), [
    ["2026-11-01", "2026-11-10"], ["2026-11-11", "2026-11-11"],
  ]);
});

test("authorized proof recovers CPF absent from both API sources with original fiscal data", async () => {
  seed();
  const result = await recuperarCuponsEditados([correcao()], true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].usuario, CPF);
  assert.equal(sent[0].numeroDocumento, "nota-teste");
  assert.equal(sent[0].dataHoraEmissao, "2026-11-02 12:38:48");
  assert.equal(sent[0].valorTotal, 100.5);
  assert.match(sent[0].extra, /comprovante editado autorizado/);
  assert.equal(cupons[0].clientes.length, 0);
  assert.equal(cupons[0].notas[0].docCliente, "");
  assert.equal(result[0].resultado, "enviado");
  assert.equal(result[0].polgoId, "polgo-1");
  assert.equal(JSON.stringify(result).includes(CPF), false);
  assert.equal(cursorWrites.length, 0);
  assert.equal(locks, 1);
  assert.equal((await recuperarCuponsEditados([correcao()], true))[0].resultado, "ja_enviado");
  assert.equal(sent.length, 1);
});

test("recovery simulation performs no database access, lock or Polgo calls", async () => {
  const result = await recuperarCuponsEditados([correcao()]);
  assert.equal(result[0].resultado, "simulado");
  assert.equal(sent.length, 0);
  assert.equal(db.getSyncedCupom.mock.callCount(), 0);
  assert.equal(db.upsertSyncedCupom.mock.callCount(), 0);
  assert.equal(locks, 0);
});

test("batch recovery handles identical sale IDs in different branches independently", async () => {
  cupons.push(cupom({ loja_id: 20, notas: [{ ...cupons[0].notas[0], chave_acesso: "nota-outra-filial" }] }));
  const result = await recuperarCuponsEditados([correcao(), correcao({ filial: 20 })], true);
  assert.deepEqual(result.map((r) => r.filial), [10, 20]);
  assert.equal(sent.length, 2);
  assert.equal(rows.size, 2);
  assert.notEqual(sent[0].numeroDocumento, sent[1].numeroDocumento);
});

test("entire recovery batch is checked before any send", async () => {
  cupons.push(cupom({ loja_id: 20 }));
  await assert.rejects(recuperarCuponsEditados([
    correcao(), correcao({ filial: 20, valorTotal: 999 }),
  ], true), /diverge/);
  assert.equal(sent.length, 0);
  assert.equal(rows.size, 0);
});

test("recovery requires matching proof, allowed branch and campaign", async () => {
  for (const overrides of [{ dataVenda: "2026-11-03" }, { numeroNota: 999 }, { valorTotal: 1 }, { filial: 30 }]) {
    await assert.rejects(recuperarCuponsEditados([correcao(overrides)], true), /diverge|fora das filiais/);
  }
  config.polgo.campanha.fim = "2026-10-31";
  await assert.rejects(recuperarCuponsEditados([correcao()], true), /fora da janela/);
  assert.equal(sent.length, 0);
});

test("recovery rejects a different fiscal key even if note number is in the sale", async () => {
  cupons[0].notas.push({ ...cupons[0].notas[0], nnf: 1235, chave_acesso: "outra-nota" });
  await assert.rejects(recuperarCuponsEditados([correcao({ numeroNota: 1235 })], true), /chave selecionada diverge/);
  assert.equal(sent.length, 0);
});

test("recovery never reinserts a canceled or previously linked document", async () => {
  for (const [status, extra] of [
    ["canceled", {}], ["error", { polgo_document_id: "previous-document" }],
    ["skipped", { last_error: "Ja existe na Polgo (documento ja inserido) - tratado como concluido" }],
  ]) {
    seed(status, null, extra);
    await assert.rejects(recuperarCuponsEditados([correcao()], true), /nao sera reinserido|nao concluido/);
  }
  cupons[0].isestornado = true;
  await assert.rejects(recuperarCuponsEditados([correcao()], true), /cancelado/);
  assert.equal(sent.length, 0);
});

test("failed recovery is explicit and can be retried with the same authorized batch", async (t) => {
  seed();
  const sendMock = t.mock.method(PolgoClient.prototype, "inserirDocumentoFiscal", async () => {
    throw new Error("Polgo unavailable");
  });
  await assert.rejects(recuperarCuponsEditados([correcao()], true), /envio nao concluido/);
  assert.equal(rows.get(key(101, 10)).status, "error");
  sendMock.mock.restore();
  assert.equal((await recuperarCuponsEditados([correcao()], true))[0].resultado, "enviado");
});

test("corrected CPF never inherits the name of a different consumer", () => {
  const c = cupom({ clientes: [{ cod: 1, cpf_cnpj: "98765432100", dadosAdicionais: { nome: "Outro" } }] });
  assert.equal(mapCupomToDocumentoFiscal(c, CNPJ, CPF).consumidor, undefined);
});

test("malformed, duplicate and numeric CPF corrections are rejected before access", async () => {
  for (const input of [null, [], [{}], [correcao({ cpf: 12345678901 })],
    [correcao({ cpf: CNPJ })], [correcao({ cpf: "bad" })], [correcao({ vendaId: -1 })],
    [correcao({ dataVenda: "2026-02-30" })], [correcao(), correcao()]]) {
    await assert.rejects(recuperarCuponsEditados(input, true));
  }
  assert.equal(parseCuponsEditados([correcao({ cpf: "012.345.678-90" })])[0].cpf, CPF);
  assert.equal(TabletCloudClient.prototype.getCupom.mock.callCount(), 0);
  assert.equal(locks, 0);
});

test("single-coupon API lookup checks both sale and branch identity", async () => {
  let requested;
  const client = {
    getAccessToken: async () => "test-token",
    http: { get: async (path) => { requested = path; return { data: cupom() }; } },
  };
  assert.equal((await realGetCupom.call(client, 101, 10)).venda_id, 101);
  assert.equal(requested, "/cupom/get/101/10");
  await assert.rejects(realGetCupom.call(client, 101, 20), /identidade divergente/);
  client.http.get = async () => ({ data: null });
  await assert.rejects(realGetCupom.call(client, 101, 10), /nao encontrado/);
});

test("MySQL lock excludes another process and releases after success or failure", async () => {
  for (const outcome of ["success", "failure", "busy"]) {
    const queries = [];
    let released = 0, ran = false;
    fakePool.getConnection = async () => ({
      query: async (sql, args) => {
        queries.push(sql);
        assert.ok(args[0].length <= 64);
        return [[{ acquired: outcome === "busy" ? 0 : 1 }]];
      },
      release: () => { released++; },
      destroy: () => assert.fail("Unexpected destroy"),
    });
    const work = async () => { ran = true; if (outcome === "failure") throw new Error("work failed"); return 42; };
    if (outcome === "success") assert.equal(await realWithSyncLock(work), 42);
    else await assert.rejects(realWithSyncLock(work), outcome === "busy" ? /execucao/ : /work failed/);
    assert.equal(ran, outcome !== "busy");
    assert.equal(queries.some((q) => q.includes("RELEASE_LOCK")), outcome !== "busy");
    assert.equal(released, 1);
  }
});

test("lock release failure does not turn a completed sync into a failure", async () => {
  let released = 0, destroyed = 0;
  fakePool.getConnection = async () => ({
    query: async (sql) => {
      if (sql.includes("RELEASE_LOCK")) throw new Error("connection lost");
      return [[{ acquired: 1 }]];
    },
    release: () => { released++; },
    destroy: () => { destroyed++; },
  });
  assert.equal(await realWithSyncLock(async () => 7), 7);
  assert.equal(destroyed, 1);
  assert.equal(released, 1);
});

test("production admin endpoints replay ranges, query status and recover edited coupons", async (t) => {
  const { createServer } = require("../dist/server");
  const { isSyncRunning } = require("../dist/jobs/syncRunner");
  config.server.adminApiKey = "admin-test";
  const server = createServer().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) => fetch(base + path, {
    ...init, headers: { "Content-Type": "application/json", "X-API-KEY": "admin-test", ...init.headers },
  });

  assert.equal((await call("/sync/cupom/10/101", { headers: { "X-API-KEY": "x" } })).status, 401);
  assert.equal((await call("/sync/cupom/10/101")).status, 404);
  assert.equal((await call("/sync/trigger?de=2026-11-03", { method: "POST" })).status, 400);
  assert.equal((await call("/sync/trigger?de=2026-11-03&ate=2026-11-02", { method: "POST" })).status, 400);
  assert.equal((await call("/sync/trigger?de=2026-10-01&ate=2026-11-30", { method: "POST" })).status, 400);
  assert.equal(ranges.length, 0);

  const trigger = await call("/sync/trigger?de=2026-11-02&ate=2026-11-02", { method: "POST" });
  assert.equal(trigger.status, 202);
  while (isSyncRunning()) await new Promise((r) => setTimeout(r, 5));
  assert.equal(ranges.length, 1);
  assert.equal(toDateOnly(ranges[0].from), "2026-11-02");
  assert.deepEqual(cursorWrites, []);
  assert.equal(rows.get(key(101, 10)).status, "skipped");

  const body = (enviar) => JSON.stringify({ enviar, cupons: [correcao()] });
  const simulado = await call("/sync/recuperar-editados", { method: "POST", body: body(false) });
  assert.equal(simulado.status, 200);
  assert.equal((await simulado.json()).resultados[0].resultado, "simulado");
  assert.equal(sent.length, 0);

  const invalido = await call("/sync/recuperar-editados", {
    method: "POST", body: JSON.stringify({ enviar: true, cupons: [correcao({ cpf: "123" })] }),
  });
  assert.equal(invalido.status, 400);
  const divergente = await call("/sync/recuperar-editados", {
    method: "POST", body: JSON.stringify({ enviar: true, cupons: [correcao({ valorTotal: 99 })] }),
  });
  assert.equal(divergente.status, 422);
  assert.equal(sent.length, 0);

  const enviado = await call("/sync/recuperar-editados", { method: "POST", body: body(true) });
  assert.equal(enviado.status, 200);
  assert.equal((await enviado.json()).resultados[0].resultado, "enviado");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].usuario, CPF);

  const status = await call("/sync/cupom/10/101");
  assert.equal(status.status, 200);
  assert.equal((await status.json()).cupom.status, "sent");
});

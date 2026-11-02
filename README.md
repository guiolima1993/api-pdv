# pdv-polgo-bridge

Serviço intermediário entre o **TabletCloud** (PDV) e a **Polgo** (documentos
fiscais para sorteios da Loteria Federal). Ele lê as vendas (cupons) do
TabletCloud periodicamente e envia cada venda válida para
`POST /documentoFiscal/v1/inserir` na Polgo, para que ela seja assimilada à
campanha do sorteio vigente.

## Como funciona

1. A cada execução (cron), o serviço busca no TabletCloud
   (`GET cupom/get/{offset}/{dataInicial}/{datafinal}/{filiais}`) todas as
   vendas emitidas desde a última sincronização bem-sucedida (cursor salvo em
   SQLite). A API do TabletCloud limita o intervalo a 10 dias e 100 registros
   por página — o serviço faz o chunking e a paginação automaticamente.
2. Cada cupom é convertido para o formato esperado pela Polgo
   ([`src/mappers/cupomToDocumentoFiscal.ts`](src/mappers/cupomToDocumentoFiscal.ts)):
   - `usuario`: CPF/CNPJ do cliente da venda (obrigatório — é o identificador
     usado pela Polgo para vincular a venda ao consumidor no sorteio). Vendas
     sem CPF/CNPJ identificado são marcadas como `skipped` e não são enviadas.
   - `numeroDocumento`: chave de acesso da nota fiscal quando disponível,
     senão `{filial}-{vendaId}`.
   - `campanha`: ano + identificação configurados via variáveis de ambiente
     (fornecidos pelo time de Onboarding da Polgo).
   - Demais campos (itens, forma de pagamento, vendedor, consumidor) mapeados
     a partir do cupom.
3. Antes do primeiro envio, o serviço se autentica em
   `POST /login/v1/autenticacao` e reaproveita o token (renovando em caso de
   `401`).
4. Todo cupom processado é registrado em MySQL
   ([`src/db.ts`](src/db.ts), tabelas `synced_cupons`/`sync_state`, variáveis
   `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`) com status
   `sent | skipped | canceled | error`, evitando duplicidade em reprocessamentos.
   Usa MySQL (não arquivo local) porque hospedagens gerenciadas como a
   Hostinger não persistem disco local entre deploys.
5. Se uma venda já enviada aparecer cancelada/estornada em uma sincronização
   posterior, o serviço chama
   `POST /documentoFiscal/v1/documentos/cancelar` na Polgo.

## Configuração

Copie `.env.example` para `.env` e preencha:

- `TABLETCLOUD_TOKEN`: token de acesso do parceiro/loja no TabletCloud.
- `TABLETCLOUD_FILIAIS`: códigos das filiais a monitorar (separados por vírgula).
- `POLGO_USUARIO` / `POLGO_SENHA`: credenciais fornecidas pela Polgo (Onboarding).
- `POLGO_CAMPANHA_ANO` / `POLGO_CAMPANHA_IDENTIFICACAO`: dados da campanha do
  sorteio, fornecidos pela Polgo.
- `POLGO_CAMPANHA_INICIO` / `POLGO_CAMPANHA_FIM` (`YYYY-MM-DD`): janela de datas
  de venda aceita pela campanha. Vendas fora dela são marcadas como `skipped`
  sem chamar a Polgo. Se a janela for alterada depois (ex.: prorrogação), as
  vendas puladas por esse motivo voltam a ser enviadas automaticamente no
  próximo ciclo que as buscar na TabletCloud. **Mantenha alinhado com a janela
  cadastrada na Polgo** — rejeições deles por "fora do prazo" viram `skipped`
  terminal.
- `SYNC_CRON`: frequência de execução (padrão: a cada 10 minutos).
- `SYNC_KEEPALIVE_URL`: URL pública do próprio serviço (ex.:
  `https://api-pdv.seudominio.com.br/health`). Enquanto uma sincronização roda,
  o processo faz um GET nela a cada 10 s (`SYNC_KEEPALIVE_INTERVAL_MS`) para a
  hospedagem não encerrar o processo por "inatividade HTTP" no meio de um ciclo
  longo — a Hostinger faz isso após ~30–40 s sem requisições de entrada, e o
  `POST /sync/trigger` responde `202` imediatamente. Vazio = desativado.
- `ADMIN_API_KEY`: chave exigida no header `X-API-KEY` para acionar
  `POST /sync/trigger` manualmente (ex.: via cron-job.org externo).

> **Atenção**: `cnpjEmitente` é preenchido com o CNPJ real de cada filial,
> obtido via `GET filial/get` do TabletCloud (campo `cnpj`) e mapeado por
> `loja_id`. Filiais sem CNPJ cadastrado na TabletCloud são ignoradas (vendas
> registradas como `skipped`).

## Rodando localmente

```bash
npm install
npm run dev          # modo desenvolvimento com reload
npm run sync:once    # dispara uma sincronização única e finaliza
```

## Build e produção

```bash
npm run build
npm start
```

Ou via Docker:

```bash
docker compose up --build -d
```

## Endpoints HTTP

- `GET /health` — healthcheck simples.
- `GET /sync/status` — contagem de cupons por status.
- `POST /sync/trigger` — dispara uma sincronização manual. Requer header
  `X-API-KEY: <ADMIN_API_KEY>`.

## Pontos em aberto / a validar com os times de negócio

- **Autenticação TabletCloud**: a documentação pública não detalha o fluxo de
  obtenção do token (aparenta ser fornecido pelo painel do parceiro/OEM). O
  serviço está preparado para enviar esse token via header configurável
  (`TABLETCLOUD_AUTH_HEADER` / `TABLETCLOUD_AUTH_SCHEME`).
- **Multi-campanha / multi-filial → múltiplas campanhas Polgo**: hoje há uma
  única campanha configurada globalmente. Se cada filial pertencer a uma
  campanha diferente, será necessário um mapeamento `Loja_id -> campanha`.
- **CNPJ do emitente**: resolvido automaticamente via `GET filial/get` da
  TabletCloud (ver observação acima).

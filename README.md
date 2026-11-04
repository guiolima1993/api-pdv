# pdv-polgo-bridge

Serviço intermediário entre o **TabletCloud** (PDV) e a **Polgo** (documentos
fiscais para sorteios da Loteria Federal). Ele lê as vendas (cupons) do
TabletCloud periodicamente e envia cada venda válida para
`POST /documentoFiscal/v1/inserir` na Polgo, para que ela seja assimilada à
campanha do sorteio vigente.

## Como funciona

1. A cada execução (cron), o serviço busca no TabletCloud
   (`GET cupom/get/{offset}/{dataInicial}/{datafinal}/{filiais}`) todas as
   vendas emitidas desde a última sincronização bem-sucedida, com sobreposição
   configurável para edições recentes (cursor salvo em MySQL). A API do
   TabletCloud limita o intervalo a 10 dias e 100 registros
   por página — o serviço faz o chunking e a paginação automaticamente.
2. Cada cupom é convertido para o formato esperado pela Polgo
   ([`src/mappers/cupomToDocumentoFiscal.ts`](src/mappers/cupomToDocumentoFiscal.ts)):
   - `usuario`: CPF de pessoa física do consumidor (obrigatório — é o identificador
     usado pela Polgo para vincular a venda ao consumidor no sorteio). Vendas
     sem CPF identificado são marcadas como `skipped` e não são enviadas.
     Se o CPF for incluído depois no PDV (a edição é permitida após a impressão)
     e passar a vir na TabletCloud, a venda é reavaliada e enviada no próximo
     ciclo que a buscar.
     O CPF é lido de `clientes[].cpf_cnpj` (cliente não cancelado) ou, na
     ausência dele, de `notas[].docCliente` de uma nota emitida, autorizada e
     não cancelada. CNPJ não identifica participante pessoa física.
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
- `SYNC_EDIT_LOOKBACK_MINUTES` (padrão `60`): quantos minutos antes do último
  ciclo cada sincronização volta a buscar. Como a TabletCloud só filtra por dia
  inteiro, isso inclui o dia anterior quando a sobreposição cruza a meia-noite.
  É a janela de **reconsulta**, não um prazo máximo permitido para editar.
  Não cobre alterações que só cheguem à API depois dessa janela, nem faz um
  CPF ausente aparecer na resposta. `0` desativa a sobreposição.
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
npm test            # build + testes isolados, sem APIs ou banco reais
```

## Cupons editados após a impressão

Uma venda ignorada por falta de CPF deixa de ser terminal: quando ela volta
na consulta com CPF, é reavaliada pelas mesmas regras de cancelamento e
campanha e enviada. Vendas já enviadas não são reinseridas, mesmo se o CPF
mudar. Corrigir o participante de uma venda **já enviada** exige outro
procedimento com a Polgo; este fluxo recupera vendas ainda não enviadas.

Para recuperar períodos antigos depois de a TabletCloud disponibilizar as
correções, use um intervalo explícito. **Este comando envia vendas aptas**,
respeita os status já gravados e não altera o cursor do cron:

```bash
npm run sync:once -- --de=2026-11-02 --ate=2026-11-02
```

### CPF consta no comprovante, mas não vem na API

Reconsultar não permite descobrir um CPF que a API não devolve. O comprovante
editado pode ser usado como fonte **conferida e autorizada pelo responsável**,
sem alterar a TabletCloud, a chave da nota, o valor ou a data original da venda.
Há recuperação em lote para esses casos, não apenas para uma venda específica.

Prepare fora do repositório um JSON privado com a lista de comprovantes
autorizados. Exemplo com **dados fictícios**:

```json
[
  {
    "vendaId": 123456,
    "filial": 123,
    "dataVenda": "2026-11-02",
    "numeroNota": 1234,
    "valorTotal": 100.50,
    "cpf": "01234567890"
  }
]
```

`vendaId` é o `venda_id` da API, que pode ser diferente do número impresso no
PDV, e só é único junto com `filial`. O CPF deve ser uma string para preservar
zeros à esquerda. Não coloque esses arquivos no Git.

```bash
# Somente simula: consulta TabletCloud, valida todo o lote e mostra CPF mascarado.
# Não escreve no MySQL nem chama a Polgo.
npm run sync:recuperar-editados -- --arquivo=/caminho/privado/cupons.json

# Envio real: execute somente após conferir os comprovantes e a simulação.
npm run sync:recuperar-editados -- --arquivo=/caminho/privado/cupons.json --enviar
```

O envio exige MySQL acessível e a campanha configurada cobrindo a data
original da venda; ele não ignora a janela nem as rejeições da Polgo.
Data, valor e número da nota são comparados com a TabletCloud antes de
enviar. Um bloqueio MySQL compartilhado impede execução simultânea do cron,
do reprocessamento e da recuperação (todos devem usar esta versão).
O resultado é salvo em `synced_cupons`, e a origem autorizada do CPF vai
no campo `extra` da Polgo. A simulação não verifica duplicidade no banco;
essa verificação acontece no envio real. Se houver falha parcial, os
sucessos permanecem gravados; corrija a causa e repita o mesmo lote.

Para automatizar os casos ausentes da API, solicite à TabletCloud o campo
ou endpoint que devolve a inclusão/alteração de CPF **após a impressão** e
seu prazo de propagação. Informe `venda_id`, `loja_id`, data e nota, com o
comprovante, e compare `clientes[].cpf_cnpj`, `notas[].docCliente`, detalhe
`GET cupom/get/{VendaId}/{CodFilial}` e dados fiscais. Não é seguro inferir
CPF a partir de valor, horário ou cadastro de outro cliente.

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
  `X-API-KEY: <ADMIN_API_KEY>`. Com `?de=YYYY-MM-DD&ate=YYYY-MM-DD` (máx. 31
  dias) reprocessa dias antigos sem mexer no cursor.
- `GET /sync/errors` — últimos cupons com erro (`X-API-KEY`).
- `GET /sync/cupom/:filial/:vendaId` — status gravado do cupom (`sent`,
  `skipped`, `last_error`, `polgo_document_id`) (`X-API-KEY`).
- `POST /sync/recuperar-editados` — mesma recuperação do script acima, em
  produção (`X-API-KEY`). Corpo `{ "enviar": false, "cupons": [ ... ] }` (máx.
  30); sem `"enviar": true` só confere e simula.

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

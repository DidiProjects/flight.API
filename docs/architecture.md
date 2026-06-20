# Arquitetura — flight.API

REST API (Fastify + TypeScript) que orquestra o monitoramento de preços de voos: agenda raspagens, recebe resultados via webhook, avalia tarifas contra as rotinas dos usuários e envia alertas por email.

## Stack

- **HTTP:** Fastify 5 (helmet, cors, rate-limit, jwt)
- **Validação:** Zod
- **Banco:** PostgreSQL (`pg`) — schema e migrações vivem no projeto `flight.DB`
- **Auth:** JWT (usuários) + `X-API-Key` (callback do scraper)
- **Email:** nodemailer (SMTP)
- **Logs:** pino (+ pino-loki opcional para Grafana)
- **DI:** factory functions manuais (`src/container`)

## Estrutura

```
src/
  config/env.ts        # env via Zod
  container/           # DI manual
  modules/<domain>/    # interfaces, repository, service, route, schema
  services/
    scheduler/         # loops de agendamento e dispatch
    evaluation/        # avalia tarifas vs. rotinas
    notifications/     # alertas e emails agendados
    email/             # transporte SMTP
  utils/               # logger, errors, crypto
```

Cada módulo segue o padrão `interfaces/ → Repository → Service → route → schema`, registrado em `container.ts` e `app.ts`.

## Fluxo

```
flight.FRONT → flight.API ←→ flight.DB
                   ↕
             scraping.API → [Site Azul]
```

O usuário cria rotinas no FRONT. A API persiste e o scheduler trabalha em cima delas.

## Scheduler (`src/services/scheduler/SchedulerService.ts`)

O agendamento não é por rotina. O scheduler deriva `scraping_jobs` — um job por `airline × origin × destination × flight_date × user_id` (o `user_id` é o dono do job; rotinas do mesmo usuário deduplicam, usuários distintos geram jobs separados) — e cada despacho registra uma linha em `analysis_runs` (a "análise" que o usuário vê). Jobs legados sem dono ficam com `user_id NULL` até expirarem.

Loops (`start()`):

- **Derivação** (a cada `SCRAPE_INTERVAL_MS`) — expira jobs antigos, faz upsert de jobs a partir das rotinas ativas, recalcula prioridades.
- **Dispatch** (a cada `SCRAPE_INTERVAL_MS`) — por companhia, reivindica até `SCRAPE_DISPATCH_BATCH` jobs, marca `running`, cria a `analysis_run` e faz `POST /scrape` na `scraping.API`. Circuit breaker por companhia (5 falhas → abre por 15min).
- **Heartbeat** (2min) — recupera jobs travados e marca como falha `analysis_runs` paradas em `running` há mais de 15min.
- **Evaluation** (5min) — `EvaluationService.runCycle()`.
- **Daily** (tick de 1min) — a partir das 02:00, uma vez/dia: agrega `flight_fares` no bucket diário, limpa dados crus > 30d, `analysis_runs` > 60d e jobs `dead`.

Reagendamento adaptativo após sucesso (`calcNextRunAt`, por proximidade do voo): ≤7d → 1h; ≤14d → 2h; ≤30d → 4h; ≤60d → 6h; >60d → 12h. Falhas usam backoff exponencial com jitter (`calcBackoffNextRunAt`).

## Webhook — `POST /flight/scrape/results`

Recebe o callback da `scraping.API` (autenticado por `X-API-Key`/`FLIGHT_API_KEY`). Responde 200 imediato e processa async (`ScrapeService.processCallback`):

- Localiza o job por `request_id`. Sucesso → grava `flight_fares`, marca job/run `success` e reagenda.
- Erro de bloqueio/bot → pausa toda a companhia por 1h (não escala para `dead`).
- Outros erros → `failed` com backoff, ou `dead` ao atingir `max_retries`.
- Callback órfão (request_id sem job) → tenta reidratar o job pelo id em `routineId` e salva as fares (`ON CONFLICT` protege duplicatas), sem perder a coleta nem deixar a run presa em `running`.

## Avaliação (`src/services/evaluation/EvaluationService.ts`)

Para cada rotina ativa: busca a tarifa mais recente por rota/companhia, ignorando tarifas mais velhas que 48h (`MAX_FARE_AGE_HOURS`). Filtra contra o alvo da rotina (`cash`/`pts`/`hyb`) com a margem configurada, escolhe a melhor e dispara alerta — respeitando rate-limit de 24h por rotina (`hasRecentAlert`).

## Tempo real (`src/realtime/`)

O flight.API é o **hub** entre o worker de scraping e o painel Admin. Detalhes de design em `flight-monitoring.IA/features.md` (§§13–19) e contrato em `flight-monitoring.IA/contracts/realtime-protocol.ts`.

- **WS hub ← workers** (`workerGateway.ts`): `WebSocketServer` (lib `ws`) anexado ao http server do Fastify em `/realtime/worker`. O worker disca para cá (NAT-friendly) e autentica por query param `key` (= `FLIGHT_API_KEY`) no upgrade. Heartbeat ping/pong com flag `isAlive` derruba conexões mortas. Recebe telemetria (`job.queued|started|progress|log|finished`), roteia `cancel` ao worker dono do `request_id` e aguarda `cancel.ack`.
- **Barramento interno** (`hubBus.ts`): desacopla o transporte da persistência e do fan-out.
- **Persistência** (`realtimePersistence.ts`): grava cada evento em `analysis_run_events` (timeline idempotente por `seq`). `job.finished` com status `cancelled` é a **única fonte** (não há webhook em cancel) → marca `analysis_runs` cancelled e libera o job (volta a `pending`, não conta como falha).
- **SSE → admin** (`sseHub.ts`): `GET /flight/admin/stream` (JWT admin por query param, pois `EventSource` não envia header). 1º evento `job.snapshot`; depois fan-out em memória de `job.upsert`/`job.event`/`job.removed`. Ring-buffer + `Last-Event-ID` para reconexão sem buracos.
- **Controle REST** (`modules/admin`): `GET /admin/jobs`, `GET /admin/jobs/:requestId/events`, `POST /admin/jobs/:requestId/cancel`.

> Escala atual: fan-out em memória. Para flight.API horizontal, trocar por Redis pub/sub (ver features.md §10).

## Variáveis de ambiente

Definidas e validadas em `src/config/env.ts` (Zod). Toda nova var deve ir também ao `.env` e ao step `docker run` do `deploy.yml`. `REALTIME_ENABLED` (default `true`) liga/desliga o canal de tempo real (WS + SSE).

| Variável | Default | Descrição |
|---|---|---|
| `PORT` | `3011` | Porta HTTP |
| `POSTGRES_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DB` | — | Conexão PostgreSQL |
| `JWT_SECRET` | — | Segredo JWT (≥32 chars) |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | `15m` / `30d` | Validade dos tokens |
| `SCRAPE_INTERVAL_MS` | `300000` | Período dos loops de derivação/dispatch (5min) |
| `SCRAPE_INTERVAL_JITTER_MS` | `60000` | Jitter aplicado ao intervalo |
| `SCRAPE_DISPATCH_BATCH` | `1` | Jobs por companhia por tick = sessões simultâneas no mesmo IP. Manter baixo p/ evitar detecção de bot |
| `EVALUATION_INTERVAL_MS` | `300000` | Período do loop de avaliação |
| `SCRAPING_API_URL` / `SCRAPING_API_KEY` | — | Endpoint e chave da `scraping.API` |
| `FLIGHT_API_KEY` | — | Chave que o scraper usa no callback `/scrape/results` |
| `SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_FROM` | — | Envio de email |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD_INITIAL` | — | Admin inicial (seed) |
| `API_BASE_URL` / `FRONTEND_URL` | localhost | URLs base (CORS, links de email) |
| `LOG_LEVEL` | `info` | Nível pino |
| `GRAFANA_LOKI_URL` / `_USER` / `_TOKEN` | — | Envio de logs ao Loki (opcional) |

## Rodar

```
npm run start:dev   # tsx watch
npm run build       # tsc → build/
npm start           # node build/index.js
npm test            # vitest
npm run typecheck   # tsc --noEmit
```

## Deploy

GitHub Actions → build da imagem Docker → push via Tailscale SSH → `docker run` no servidor Linux. Rede Docker `flight-network` liga `flight-api` e `flight-db`. Não buildar à mão — commit + push aciona o workflow.

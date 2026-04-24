# Arquitetura — scraping.API

## Contexto

Este projeto (`scraping.API`) roda na **Windows VM** e é responsável exclusivamente por raspagem de dados. Não contém regras de negócio.

O cliente desta API é o `flight.API`, rodando no **Linux host**, que orquestra as raspagens, processa os resultados e toma decisões de negócio (alertas, emails, etc.).

---

## Fluxo

```
flight.API (Linux — 192.168.122.1)
  │
  │  POST /scrape  (X-API-Key)
  ▼
scraping.API (Windows VM — 192.168.122.224)
  │  recebe parâmetros
  │  executa raspagem (Playwright / Camoufox)
  │  POST /results  (X-API-Key)
  ▼
flight.API (Linux — 192.168.122.1)
  │  processa resultados
  │  decisões de negócio (email, alertas, etc.)
```

---

## Responsabilidades

| Projeto | Onde roda | Responsabilidade |
|---|---|---|
| `scraping.API` | Windows VM | Raspar dados, devolver resultados crus |
| `flight.API` | Linux host | Orquestrar raspagens, regras de negócio, notificações |

`scraping.API` **nunca** decide o que fazer com os dados — apenas coleta e devolve.

---

## Stack

| Camada | Tecnologia | Justificativa |
|---|---|---|
| HTTP server | **Fastify** | TypeScript-first, schema nativo, rápido |
| Validação | **Zod** | TypeScript-first, composável |
| Fila | **p-queue** | Zero dependências externas, MIT |
| DI | Manual (factory functions) | Sem magic, simples e testável |
| Outbound HTTP | **fetch nativo** (Node 22) | Sem axios |
| Auth | X-API-Key header | Stateless, seguro para comunicação interna |
| Windows service | **NSSM** | Open source, confiável |

---

## Estrutura de pastas

```
src/
  config/
    env.ts           # lê e valida variáveis de ambiente com Zod
  container/
    index.ts         # monta o container de DI (factory manual)
  middleware/
    auth.ts          # valida X-API-Key recebida
  routes/
    scrape.ts        # POST /scrape
    health.ts        # GET /health
  services/
    scraper/
      azul.ts        # lógica de raspagem Azul
      index.ts       # interface ScrapeService
    result/
      sender.ts      # envia resultado bruto para flight.API
  queue/
    index.ts         # instância p-queue + helpers
  http/
    client.ts        # wrapper fetch com retry e apikey
  types/
    scrape.ts        # ScrapeRequest, ScrapeResult
  server.ts
  main.ts
```

---

## Contrato da API

### `POST /scrape`

Chamado pelo `flight.API`.

**Headers:**
```
X-API-Key: <SCRAPER_API_KEY>
Content-Type: application/json
```

**Body:**
```json
{
  "requestId": "uuid-gerado-pelo-flight-api",
  "origin": "VCP",
  "destination": "CGH",
  "outboundStart": "2026-06-01",
  "outboundEnd": "2026-06-30",
  "returnStart": "2026-07-01",
  "returnEnd": "2026-07-31",
  "passengers": 1
}
```

**Response `202 Accepted`:**
```json
{ "requestId": "uuid-gerado-pelo-flight-api", "position": 2 }
```

---

### `GET /health`

```json
{ "status": "ok", "queue": { "size": 2, "pending": 1 } }
```

---

## Envio de resultados

Ao fim de cada raspagem, envia os dados crus para o `flight.API` sem qualquer processamento:

```ts
await fetch(`${env.FLIGHT_API_URL}/scrape/results`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': env.FLIGHT_API_KEY,
  },
  body: JSON.stringify({ requestId, results }),
});
```

---

## Fila de jobs

- Cada `POST /scrape` enfileira um job
- `QUEUE_CONCURRENCY` controla paralelismo (default: `2`)
- Jobs excedentes aguardam — sem rejeição, sem perda
- Resposta `202` imediata com posição na fila

---

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `PORT` | Porta da API (default: `3000`) |
| `SCRAPER_API_KEY` | Chave que o `flight.API` usa para chamar esta API |
| `FLIGHT_API_URL` | URL base do `flight.API` (ex: `http://192.168.122.1:3011`) |
| `FLIGHT_API_KEY` | Chave para autenticar no `flight.API` |
| `QUEUE_CONCURRENCY` | Jobs paralelos simultâneos (default: `2`) |

---

## Windows Service (NSSM)

A API inicia automaticamente com o Windows e reinicia em caso de crash.

### Instalação (uma vez, via PowerShell Admin)

```powershell
curl -o nssm.zip https://nssm.cc/release/nssm-2.24.zip
Expand-Archive nssm.zip -DestinationPath C:\nssm
copy C:\nssm\nssm-2.24\win64\nssm.exe C:\Windows\System32\

nssm install scraping-api "C:\Program Files\nodejs\node.exe"
nssm set scraping-api AppParameters "--import file:///C:/Users/diego/artifacts/scraping.API/node_modules/tsx/dist/esm/index.cjs C:/Users/diego/artifacts/scraping.API/src/main.ts"
nssm set scraping-api AppDirectory "C:\Users\diego\artifacts\scraping.API"
nssm set scraping-api Start SERVICE_AUTO_START
nssm set scraping-api AppStdout "C:\Users\diego\artifacts\scraping.API\logs\service.log"
nssm set scraping-api AppStderr "C:\Users\diego\artifacts\scraping.API\logs\service-error.log"
nssm set scraping-api AppStdoutCreationDisposition 4
nssm set scraping-api AppStderrCreationDisposition 4

New-Item -ItemType Directory -Path "C:\Users\diego\artifacts\scraping.API\logs" -Force
nssm start scraping-api
```

### Comandos úteis

```powershell
nssm status scraping-api
nssm restart scraping-api
nssm stop scraping-api
nssm remove scraping-api
```

---

## Deploy (GitHub Actions)

1. Garantir que a VM está rodando
2. `git pull`
3. `npm ci`
4. `npm run build`
5. `nssm restart scraping-api`
6. `GET /health` para confirmar que subiu

> A VM fica rodando permanentemente — sem shutdown após deploy.

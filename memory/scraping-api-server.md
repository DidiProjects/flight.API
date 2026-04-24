---
name: Contrato da API e tipos do scraping.API
description: Rotas, tipos completos, callback para flight.API, variáveis de ambiente — tudo que flight.API precisa saber para se comunicar com scraping.API
type: project
---

## Servidor

Fastify (`src/server.ts`). Sem logger embutido do Fastify, usa pino customizado (`src/utils/logger.ts`).

## Rotas

### GET /health
Sem autenticação. Retorna:
```json
{ "status": "ok", "queue": { "size": 0, "pending": 0 } }
```

### POST /scrape
**Auth:** header `X-API-Key: <SCRAPER_API_KEY>`
**Body (JSON):**
```typescript
{
  requestId:     string;   // UUID v4
  origin:        string;   // IATA 3 chars, ex: "VCP"
  destination:   string;   // IATA 3 chars, ex: "LIS"
  outboundStart: string;   // "YYYY-MM-DD"
  outboundEnd:   string;   // "YYYY-MM-DD"
  returnStart?:  string;   // "YYYY-MM-DD", omitir para só ida
  returnEnd?:    string;   // "YYYY-MM-DD"
  passengers:    number;   // inteiro 1–9
}
```
**Resposta:** `202 { requestId: string, position: number }`
O job entra na fila. Quando concluído, scraping.API faz POST de volta para flight.API.

## Callback (resultado assíncrono)

Após scraping concluído (ou falho), scraping.API faz:
```
POST {FLIGHT_API_URL}/scrape/results
X-API-Key: {FLIGHT_API_KEY}
Content-Type: application/json
```
Body (`ScrapeResult`):
```typescript
{
  requestId:   string;
  origin:      string;
  destination: string;
  flights:     FlightOffer[];
  scrapedAt:   string;   // ISO 8601
  error?:      string;   // presente apenas em falha
}
```
`flights: []` + `error` preenchido = falha. `flights: []` sem `error` = rota sem voos disponíveis (não é erro).

## Tipos completos

```typescript
interface FlightOffer {
  date:         string;          // "YYYY-MM-DD"
  flightNumber: string;          // "AD8901"
  origin:       { iata: string; timestamp: string };  // ISO 8601 com TZ offset
  destination:  { iata: string; timestamp: string };
  durationMin:  number;
  stops:        number;
  fares: {
    brl?:    { amount: number; currency: 'BRL' };
    points?: { amount: number; currency: 'PTS' };   // pontos puro, raro em internacionais
    hybrid?: { points: number; cash: number; currency: 'BRL' };
  };
  isReturn: boolean;   // true = voo de volta
}
```

**Regra de validação (flight.API deve aplicar):**
- Passagem com `fares = {}` (sem brl, points nem hybrid) → descartar
- Fares individuais vazios são aceitáveis (pode ter só brl, só hybrid, etc.)

## Fila

`p-queue` com `concurrency: QUEUE_CONCURRENCY` (default 2). Jobs paralelos simultâneos limitados por essa variável.

## Retry (HTTP outbound)

`src/utils/retry.ts`: exponential backoff + jitter. 4 tentativas, delay inicial 2s, máximo 30s.
Usado no callback para flight.API.

## Variáveis de ambiente (obrigatórias)

```
PORT=3000                 # porta do servidor
SCRAPER_API_KEY=...       # chave para autenticar requests recebidos
FLIGHT_API_URL=...        # URL base do flight.API (ex: http://192.168.122.1:4000)
FLIGHT_API_KEY=...        # chave para autenticar o callback enviado ao flight.API
QUEUE_CONCURRENCY=2       # jobs em paralelo
LOGS_DIR=./logs           # diretório de runs/snapshots
LOG_LEVEL=info
LOG_PRETTY=false
```

## Estrutura de logs/runs

```
logs/
  2026-04-24T10-30-00/
    results.json              ← { runAt, totalFound, results: FlightOffer[] }
    snapshots/*.html          ← snapshot HTML por etapa
    errors/
      execution.log
      debug-*.png
      dom-*.html
    2026-05-01/
      VCP-LIS.json            ← FlightOffer[] por data/rota
```
Mantém as 10 runs mais recentes (prune automático).

## AI Fallback

`src/agent.ts`: ativado por `npm run ai-fix` no GHA quando `npm start` falha.
- Modelo: claude-sonnet-4-6
- Budget: 180k tokens, para em 25k restantes, max 10 iterações
- Tools: bash, read_file, write_file, list_dir
- Em sucesso: git add -A && git commit && git push

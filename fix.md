# Fix: disparo manual de rotina despachava a rota errada

## Sintoma
Ao disparar manualmente uma rotina de **volta** no front (ex.: `LIS→VCP`), a
rotina de **ida** (`VCP→LIS`) era disparada no lugar.

Contexto: ida e volta são **rotinas separadas, com ids distintos** — a tabela
`routines` só tem `outbound_start`/`outbound_end` (não existe coluna de volta),
então um trajeto round-trip é modelado como duas rotinas one-way. Elas não
compartilham id; o problema não era de modelagem, e sim do dispatch.

## Causa raiz
`SchedulerService.dispatchOne(routineId)` **não despachava o job daquela rotina**.
Ele fazia:

```ts
await this.scrapingJobRepo.upsertFromRoutine(routineId) // bump: priority=100, next_run_at=NOW
await this.dispatchForAirlines(1)                        // despacha 1 job POR COMPANHIA
```

O `dispatchForAirlines(1)` despacha o **topo da fila de cada companhia** via
`claimNextJob`:

```sql
ORDER BY priority DESC, next_run_at ASC
LIMIT 1
```

Como ida e volta são a **mesma companhia**, e o job da ida frequentemente já
estava com `priority = 100` (o `updatePriorities` dá 100 para datas próximas) e
`next_run_at` no passado (atrasado), ele ganhava do job da volta — que acabara de
receber `next_run_at = NOW()`. Resultado: o `claimNextJob` escolhia a **ida**.

Ou seja, o disparo manual só subia a prioridade da rota clicada e depois pegava
"o topo da fila da companhia", que podia ser outra rota.

## Correção
O disparo manual passou a ser **direcionado à rota da rotina**.

1. **`ScrapingJobRepository.claimNextJobForRoutine(routineId)`** — reivindica
   apenas jobs que casam com a rota daquela rotina (JOIN `routines` +
   `routine_airlines`, filtrando `origin`/`destination` e o grid de datas
   `outbound_start..outbound_end`). É o equivalente ao `claimNextJob`, mas
   amarrado à rotina.

2. **`SchedulerService.dispatchClaimedJob(job)`** — extraído de `dispatchNextJob`.
   Contém toda a mecânica de despachar um job já reivindicado (gera `requestId`,
   monta payload, chama o scraper, `markRunning`/`markFailed`/`markDead`,
   registra a `analysis_run`). `dispatchNextJob` agora só reivindica e delega.

3. **`SchedulerService.dispatchOne(routineId)`** virou um loop direcionado:

   ```ts
   await this.scrapingJobRepo.upsertFromRoutine(routineId)
   while (await this.scrapingJobRepo.countInFlight() < cap) {
     const job = await this.scrapingJobRepo.claimNextJobForRoutine(routineId)
     if (!job) break
     const result = await this.dispatchClaimedJob(job)
     if (result === 'busy') break
   }
   ```

Agora disparar a volta reivindica e despacha **só os jobs da rota da volta**; a
ida (outra rotina/id) nunca é tocada.

### Efeito colateral (positivo)
O disparo manual passa a cobrir **todas as datas elegíveis** da rotina (limitado
por `SCRAPE_MAX_IN_FLIGHT` e parando no 503 do scraper), em vez de apenas 1 job —
mais alinhado com "rodar essa rotina agora".

## Arquivos alterados
- `src/modules/scraping-jobs/ScrapingJobRepository.ts` — `claimNextJobForRoutine`
- `src/modules/scraping-jobs/interfaces/IScrapingJobRepository.ts` — assinatura
- `src/services/scheduler/SchedulerService.ts` — `dispatchClaimedJob` +
  `dispatchOne` direcionado
- `src/services/scheduler/SchedulerService.test.ts` — mock + asserção de que
  `dispatchOne` usa `claimNextJobForRoutine` (e não `claimNextJob`/`getActiveAirlines`)

## Validação
- `npm run typecheck` — ok
- `npm test` — 58 testes passam (os logs de `503`/`circuit_breaker_open` vêm dos
  testes que rejeitam o dispatch de propósito)

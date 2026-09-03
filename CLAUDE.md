# flight.API

REST API Fastify do monitoramento de voos. Arquitetura completa — scheduler,
webhook, ciclo de avaliação, env vars — em `docs/architecture.md`.

Regras gerais (autonomia, commits, testes, comentários) vivem em `~/.claude/`.
Aqui só o que é armadilha **deste** repositório.

## Padrão de módulo

Módulo novo segue exatamente esta forma, e é registrado no `container.ts` e no
`app.ts`:

```
interfaces/I<Domain>Repository.ts
interfaces/I<Domain>Service.ts
<Domain>Repository.ts    ← implements a interface, recebe Pool no construtor
<Domain>Service.ts       ← implements a interface, recebe repositórios no construtor
route.ts                 ← factory(service) → plugin Fastify
schema.ts                ← Zod
```

Repositório não fala com a rede. Quem abre socket é service.

## Armadilhas medidas

- **`NUMERIC` volta do pg como string.** `"4921.00" + "7627.00"` concatena, vira
  `NaN` e some do JSON. Coagir com `Number()` antes de somar ou comparar.
- **Senhas só com `bcryptjs` (12 rounds)** via `src/utils/crypto.ts`. Nunca
  PBKDF2 — o banco usa pgcrypto/bcrypt e os hashes precisam bater.
- **`tsconfig.json` exclui `**/*.test.ts`**: erro de tipo em teste não aparece
  no `npm run typecheck`. Só rodando os testes. Pior caso medido: argumento novo
  no construtor de um service deixa o mock do teste desatualizado, a dependência
  chega `undefined` e o `try/catch` engole o `TypeError` — a suíte fica verde
  sobre um caminho que não faz nada. Ao mexer em construtor, procurar os
  `new <Service>(` dos testes na mão.
- **Bloqueio de companhia se decide pelo `outcome` do callback**, não pelo texto
  do erro. O casamento por regex sobrou como retaguarda para callback sem
  `outcome`, e era ele que pausava a LATAM por uma hora por causa de um "likely
  bot/IP block" que o próprio scraper escrevia. `SITE_ERROR` só atrasa o job, e
  nunca escala para `dead`.
- **Sem worker no hub, despachar é pior que não despachar.** O lease depende do
  heartbeat que chega pelo WS: worker desconectado significa job reivindicado
  como `lost` 60s depois e re-despachado, enquanto o scraper ainda segura a
  cópia anterior na fila dele. Medido em 2026-08-27, com o processo do scraper
  no ar e o WS caído: fila em 41 com concorrência 2, `lease_reclaim {lost: 4}`
  em todo tick e 57 callbacks órfãos. A guarda é `hasWorkers()` no início do
  laço de despacho — antes do claim, que já marca `running`.
- **Callback órfão de erro aplica a mesma política de falha.** O cooldown que
  pausa a companhia inteira vive em `applyFailurePolicy`; quando o caminho órfão
  só fechava a `analysis_run`, uma Azul bloqueada era liberada e perguntada de
  novo no ciclo seguinte. A pausa é por COMPANHIA e não precisa do job — a
  companhia está no payload. O que é por job (retry, `next_run_at`) continua
  exigindo um job que ainda seja o daquela corrida.
- **Job só é reivindicável com `retry_count < max_retries`.** Qualquer marcação
  que empurre o contador até o teto sem matar o job o deixa preso para sempre —
  ver `markSiteError`, que para em `max_retries - 1` por isso.
- **Todo despacho é um LOTE, e item de lote vivo não é reivindicável.** O
  predicado está em `modules/scraping-jobs/predicates.ts` e vale nos dois caminhos
  de claim — esquecer o `claimBatchForRoutine` é como o disparo manual volta a
  redespachar fragmento de lote. Enquanto o lote vive, o callback do item grava
  tarifa e fecha a `analysis_run`, mas **não mexe em `next_run_at` nem em
  `retry_count`**: quem decide o destino dos itens é o fechamento, com os irmãos
  na mão.
- **Bloqueio, supersede e item não tentado NUNCA contam retentativa.** Com
  `max_retries = 3` e lote de oito, contar os três mataria uma rota inteira em
  três noites ruins, onde hoje morre um job sozinho. `settleBatchItem` é onde essa
  separação vive.
- **Bloqueio precisa fechar os lotes vivos da companhia ANTES de pausá-la.**
  `pauseAirlineForBlock` devolve todo job da companhia para `pending` com
  `request_id` nulo, inclusive os `running`; se o lote seguisse vivo, esses itens
  ficariam pendentes, vencidos e invisíveis ao claim — para sempre.
- **O fechamento do lote é truncado, nunca recusado.** Um `max()` no `error`
  rejeita o fechamento inteiro por tamanho de mensagem, e fechamento recusado
  tranca a rota. Medido em 2026-09-03, na primeira corrida real.
- **Teto de execução do lote fica ACIMA do watchdog do worker.** `MAX_RUN_MIN` é
  retaguarda, não veredito: quem declara o fim de uma corrida tem que ser o lado
  que está com a evidência do que a tela fazia.
- **Zod 3 aqui, Zod 4 no flight.FRONT.** A forma de função no 2º argumento do
  `.refine` vale aqui e **não** vale lá — portar validação sem ajustar devolve
  "Invalid input".

## Variável de ambiente nova

Adicionar nos três lugares, senão quebra em produção: `src/config/env.ts` (Zod),
`.env` e o step `docker run` do `deploy.yml`.

## Banco

O schema é do projeto `flight.DB`. Mudança de coluna ou índice se resolve lá
primeiro — ver `~/.claude/` e o `CLAUDE.md` daquele repo.

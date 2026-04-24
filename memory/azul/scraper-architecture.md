---
name: Arquitetura e fluxo do scraper Azul
description: Stack, ordem exata do fluxo de automação, arquitetura de buscas, coleta de dados, estado atual do código
type: project
---
## Stack (atual, 2026-04-21)

camoufox-js + playwright (firefox headless), TypeScript/tsx, pino logger, dotenv.
- `import { firefox } from 'playwright'` + `import { launchOptions } from 'camoufox-js'`
- Substituiu rebrowser-playwright (Chromium) após detectar bloqueio Akamai em containers
- Deploy: direto no servidor via SSH (sem Docker)

## Fluxo de automação (ordem exata)

1. Navegar para `https://www.voeazul.com.br/br/pt/home`
2. `waitForEvalReady()`, retenta evaluate até contexto estabilizar
3. `checkForBlock()`, verifica se Akamai bloqueou
4. Aceitar cookies (`#onetrust-accept-btn-handler`) + force-hide overlay OneTrust
5. `waitForSearchForm()`, aguarda `input[aria-label*="Origem"]`
6. `fillSearchForm()`:
   a. Clicar container pai do `input[aria-label*="Origem"]` → digitar código → clicar `button[role="option"]`
   b. Clicar container pai do `input[aria-label*="Destino"]` → digitar → clicar option
   c. Clicar container pai do `input[aria-label*="Datas"]` → digitar DDMMYYYY
   d. Clicar `button:text("Buscar passagens")` via DOM
7. `waitForResults()` → retorna `boolean` (false = estado vazio)
8. Para cada data no range:
   a. Se i > 0: `navigateCalendarToDate()` → click button com `aria-label` contendo "DD/MM"
   b. `waitForResults()`
   c. `collectAllFares()`, coleta BRL + pontos + híbrido
9. Após toda ida → nova page/context para rota de volta

## collectAllFares, fluxo interno

1. `setCurrencyView(page, 'Reais')`, garante view BRL
2. Extrair `brlCards` de `div.flight-card[id]`:
   - `h4.departure` → depTime, depIata (via `span.iata-day`)
   - `h4.arrival` → arrTime, arrIata
   - `button.duration[aria-label]` → durLabel (parse "X hora Y minuto")
   - `.flight-leg-info button` → legText (parse conexões + voo)
   - `h4[data-test-id="fare-price"]` → priceText
3. `setCurrencyView(page, 'Pontos')`, switch para view pontos
4. Extrair `ptsCards` de `div.flight-card[id]`:
   - `h4[data-test-id="fare-price"]` → buscar "pontos" no textContent
   - `p.condition` → texto híbrido "ou X pontos + R$ Y"
5. Merge por `card.id` → `FlightOffer[]`

## setCurrencyView, detalhes importantes

- Seletor correto: `.currencySelector button[value="${value}"]` (results section)
- NÃO usar `button[value="score"].first()`, apanha o botão do painel esquerdo (search form), que não controla os cards
- Após click: `waitForLoadState('networkidle', 8s)`, o site faz chamada API para pontos
- Wait adicional de 10s verificando `h4[data-test-id="fare-price"]` para "pontos" no textContent
- Para rotas internacionais (ex: LIS↔CNF): pontos puro pode não estar disponível → h4 fica vazio → correto

## Output JSON por data

```
results/
  2026-04-21T12-00-00/
    snapshots/           ← HTML para diagnóstico após cada etapa
    errors/              ← debug-*.png + dom-*.html em falhas
    2026-05-29/
      LIS-CNF.json       ← array de FlightOffer (BRL + pontos + híbrido unificados)
```

## Tipos principais (src/types/index.ts)

```typescript
interface FlightOffer {
  date: string;               // "YYYY-MM-DD"
  flightNumber: string;       // "AD8901"
  origin: { iata: string; timestamp: string };     // ISO 8601 com TZ offset
  destination: { iata: string; timestamp: string };
  durationMin: number;
  stops: number;
  fares: {
    brl?: { amount: number; currency: 'BRL' };
    points?: { amount: number; currency: 'PTS' };  // pontos puro (raro em internacionais)
    hybrid?: { points: number; cash: number; currency: 'BRL' };
  };
  isReturn: boolean;
  withinTarget: boolean;
}
```

## AI Fallback (src/agent.ts)

Quando `npm start` falha:
- GHA executa `npm run ai-fix` → `src/agent.ts`
- Agente Claude API (claude-sonnet-4-6) diagnostica e corrige `azul.ts`
- Tools: bash, read_file, write_file, list_dir
- Budget: 180k tokens, stop em 25k restantes, max 10 iterações
- Em sucesso: `git add -A && git commit && git push`

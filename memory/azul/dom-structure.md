---
name: Estrutura DOM real do site da Azul, seletores confirmados
description: HTML exato dos elementos interativos descobertos via DevTools/snapshots
type: project
---
Todos os seletores abaixo foram confirmados via HTML real do site.

## Formulário de busca

**Origem:**
```html
<input placeholder="Digite" role="combobox" aria-label="Origem" data-cy="autocomplete-desktop-input" class="sc-hIUJlX hXJaFA">
```
- Clicar → digitar código do aeroporto (ex: "VCP")
- Autocomplete aparece como `button[role="option"]`
- Clicar no button que contém o código dentro de `<b>` (ex: `<b>VCP</b>`)

**Destino:**
```html
<input placeholder="Digite" role="combobox" aria-label="Destino" data-cy="autocomplete-desktop-input">
```
- Mesmo fluxo da origem

**Campo de datas:**
```html
<input placeholder="Selecione" aria-label="Datas (Ida e volta)" class="sc-hIUJlX hXJaFA" value="">
```
- Clicar nele → digitar data como DDMMYYYY (apenas números, sem separadores)
- Ex: 10/05/2026 → digitar "10052026"
- NÃO abre modal separado, digita diretamente no input
- Após digitar → clicar "Buscar passagens" diretamente

**Botão buscar:**
```html
<button type="button">Buscar passagens</button>
```
- Localizar por `textContent === 'Buscar passagens'`

## Página de resultados

**Indicador de carregamento completo:**
```html
<p class="results">10 voos encontrados</p>
```

**Estado vazio (nenhum voo disponível):**
```html
<p class="css-1wdbheb">Parece que não temos voos disponíveis para a data selecionada </p>
```
- Detectar com `p.css-1wdbheb`
- Tratar como resultado vazio, NÃO lançar erro, apenas logar e pular a data

**Carrossel de datas (booking-calendar):**
```html
<div class="booking-calendar__cards css-77i9f">
  <button aria-label="sex  01/05 valor da menor tarifa do dia , selecionar" class="css-17h89v5">
```
- Navegar por data clicando no button cujo `aria-label` contém "DD/MM"

**Toggle de moeda, DOIS conjuntos na página:**
```html
<!-- 1. No painel da esquerda (formulário de busca), NÃO usar para alterar view de resultados -->
<div class="radioViewer_search_box">
  <div class="radio_viewer_currency_score_container">
    <button type="button" aria-label="Reais" value="currency">Reais</button>
    <button type="button" aria-label="Pontos" value="score">Pontos</button>
  </div>
</div>

<!-- 2. Na seção de resultados, ESTE controla os cards de voo -->
<div class="currencySelector">
  <div class="radio_viewer_currency_score_container">
    <button type="button" aria-label="Reais" value="currency">Reais</button>
    <button type="button" aria-label="Pontos" value="score">Pontos</button>
  </div>
</div>
```
- **Selector correto:** `.currencySelector button[value="score"]` (resultados) ou `.currencySelector button[value="currency"]`
- `button[value="score"].first()` clica no painel esquerdo (errado), não altera os cards
- Após clicar, aguardar `networkidle` pois o site faz chamada API para buscar preços em pontos

**Classe CSS dos botões de toggle (CSS-in-JS, podem mudar):**
- Botão ativo: `css-6fpksg`
- Botão inativo: `css-i3qimh`
- NÃO depender dessas classes, usar `value` attribute

## Cards de voo (`div.flight-card[id]`)

```html
<div class="flight-card" id="QUR_...base64...">
  <h4 class="departure">
    10:00
    <span class="iata-day">LIS</span>
  </h4>
  <h4 class="arrival">
    20:55
    <span class="iata-day arrival">CNF</span>
  </h4>
  <button class="duration" aria-label="Tempo de duração: 14 hora 55 minuto. Ver detalhes">
  <div class="flight-leg-info">
    <button>1 conexão  •  Voo 8901</button>
  </div>
  <!-- View Reais: -->
  <h4 data-test-id="fare-price" class="current css-2db79l">
    <span class="currency">R$</span>10.274<span class="decimal">,</span><span class="fraction">24</span>
  </h4>
  <!-- View Pontos (o mesmo h4 muda de conteúdo): -->
  <h4 data-test-id="fare-price" class="current css-2db79l">
    <!-- pode ficar vazio para rotas sem pontos puro -->
  </h4>
  <!-- Preço híbrido (sempre em p.condition): -->
  <p class="condition">ou 18.711 pontos + R$ 3.065,31</p>
</div>
```

**Extração de pontos puro:**
- `h4[data-test-id="fare-price"]` textContent → procurar `/(\d+)\s*pontos/i`
- Para rotas internacionais LIS↔CNF: pontos puro NÃO disponível (h4 fica vazio)
- `p.condition` sempre contém opção híbrida quando disponível

**Parsing de valores:**
- BRL view: `h4[data-test-id="fare-price"]` → `innerText` → regex `/R?\$?([\d.]+)[,.](\d{2})$/`
- Pontos puro: textContent com "pontos" → `/(\d+\.\d+)\s*pontos/i` → remover pontos → parseInt
- Híbrido: `p.condition` → `/([\d.]+)\s*pontos?\s*\+\s*R\$\s*([\d.,]+)/i`

## Inputs com opacity:0 (styled-components)

Origem, Destino e Datas são inputs com CSS `opacity:0`, não são "visíveis" pelo Playwright.
Solução: usar `page.mouse.click(x, y)` com coords reais via `getBoundingClientRect()` do container.

## tsx/esbuild + page.evaluate, ATENÇÃO

tsx 4.x compila com `keepNames: true` → adiciona `__name(fn, "nome")` em funções nomeadas.
Quando `page.evaluate(() => { function walk() {} })` é serializado, o browser não encontra `__name` → erro.

**Regra:** NUNCA usar `function nomeFuncao()` dentro de callbacks de `page.evaluate` ou `page.waitForFunction`.
Usar abordagem iterativa com stack/array ou lambdas anônimas sem nome.

## Browser: camoufox-js + playwright (firefox)

Stack atual: camoufox-js com `firefox` do playwright (substituiu rebrowser-playwright).
Import: `import { firefox } from 'playwright'` + `import { launchOptions } from 'camoufox-js'`.
Tipos: `import type { Browser, Page } from 'playwright'` (NÃO rebrowser-playwright, evita conflito de tipos).

---
name: Projeto legado flight.API — state.json, lógica de email e tipos
description: Estrutura do state.json, lógica de notificação, template de email e tipos do projeto antigo — referência para projetar flight.DB e o novo flight.API
type: project
---

## O que era o projeto antigo

Script Node.js (não server), rodava via cron no GHA a cada hora.
Recebia parâmetros via env vars / CLI (origin, destination, targets, date ranges).
Fazia scraping, atualizava state.json, enviava email conforme regras abaixo.
Não tinha banco de dados — tudo em arquivo JSON local.

## state.json — estrutura completa

```json
{
  "days": {
    "2026-05-01": {
      "runCount": 5,
      "best": {
        "outbound": {
          "brl": { "amount": 1500.00, "offer": { ...FlightOffer } },
          "pts": { "amount": 50000,   "offer": { ...FlightOffer } },
          "hyb": { "amount": 15000,   "offer": { ...FlightOffer } }
        },
        "return": {
          "brl": { "amount": 1200.00, "offer": { ...FlightOffer } },
          "pts": null,
          "hyb": null
        }
      },
      "lastEmailed": {
        "outbound": 1500.00,
        "return": 1200.00,
        "type": "brl"
      },
      "bestOfDayEmailSentAt": "2026-05-01T20:00:00.000Z"
    }
  }
}
```

- `best.outbound/return` armazena o melhor FlightOffer acumulado do dia por tipo (brl, pts, hyb)
- `lastEmailed` registra o valor (amount) enviado no último email por direção
- `bestOfDayEmailSentAt` impede reenvio do best-of-day no mesmo dia

## Lógica de notificação (a migrar para flight.API)

### Modo alerta (target atingido)
- Se algum voo está dentro do target (com margem): dispara email imediatamente
- Só envia se o preço melhorou vs `lastEmailed` (evita spam de preço igual)
- Compara outbound e return separadamente
- Prioridade de tipo: brl > pts > hyb (primeiro tipo que bate target vira o email)

### Modo best-of-day (target NÃO atingido)
- Após 20 runs no dia sem target hit: envia email com melhor preço acumulado
- Só envia uma vez por dia (`bestOfDayEmailSentAt`)
- Preço acumulado é o menor de todos os runs do dia para cada tipo

### Anti-spam (day rollover)
- Se hoje ainda não tem `lastEmailed`, compara com `lastEmailed` de ontem
- Evita reenvio de preço igual quando o dia vira

## Targets e margem

```typescript
interface Targets {
  brl?:    number;   // preço alvo em BRL
  pts?:    number;   // preço alvo em pontos puros
  hybPts?: number;   // componente máximo de pontos no híbrido
  hybBrl?: number;   // componente máximo de cash no híbrido
}
// margin: 0.1 = aceita até target * 1.1
```
Pelo menos um target deve estar definido. Tipos são independentes.

## FlightOffer no projeto antigo (vs novo)

O antigo tinha `withinTarget: boolean` como campo computado.
O novo (scraping.API) **não tem** `withinTarget` — é computado na aplicação.
No novo flight.API, `withinTarget` deve ser computado ao receber o resultado do scraping.

## Email — template e layout

**Stack:** nodemailer, HTML inline styles.

**Layout:**
- Max-width 600px, centralizado, fundo cinza (#f5f5f5)
- Header dark (#1a1a1a) com título branco
- Corpo branco com blocos de oferta por card
- Footer cinza com timestamp BRT

**Conteúdo de cada bloco de oferta:**
- Label (ex: "Ida  VCP → LIS")
- Data formatada em pt-BR (ex: "quarta-feira, 4 de junho de 2026")
- Voo, Partida (HH:mm — IATA), Chegada (HH:mm — IATA)
- Duração | escalas
- Tarifa (formatada por tipo)
- Botão "Ver passagens disponíveis" → deep-link direto para Azul

**Deep-link Azul:**
```
https://www.voeazul.com.br/br/pt/home/selecao-voo
  ?c[0].ds=VCP&c[0].std=MM/DD/YYYY&c[0].as=LIS
  &p[0].t=ADT&p[0].c=1&p[0].cp=false
  &f.dl=3&f.dr=3
  &cc=BRL  (ou PTS para pontos/híbrido)
```

**Tipos de email:**
1. `buildAlertEmail` — subject: "Azul — Tarifa disponível: VCP → LIS"
2. `buildBestOfDayEmail` — subject: "Azul — Melhor tarifa do dia: VCP → LIS"

**SMTP config (env vars):**
- EMAIL_SMTP_HOST, EMAIL_SMTP_PORT (default 587), EMAIL_SMTP_USER, EMAIL_SMTP_PASSWORD
- EMAIL_RECIPIENT (to), EMAIL_CC (opcional)
- EMAIL_ENABLED: "true" para ativar

## Variáveis de ambiente do projeto antigo

```
FLIGHT_ORIGIN, FLIGHT_DESTINATION
FLIGHT_TARGET_BRL, FLIGHT_TARGET_PTS
FLIGHT_TARGET_HYB_PTS, FLIGHT_TARGET_HYB_BRL
FLIGHT_MARGIN (default 0.1)
FLIGHT_OUTBOUND_START, FLIGHT_OUTBOUND_END
FLIGHT_RETURN_START, FLIGHT_RETURN_END
FLIGHT_PASSENGERS (default 1)
FLIGHT_VERBOSE
RESULTS_DIR (default ./results)
LOG_LEVEL, EMAIL_ENABLED, EMAIL_RECIPIENT, EMAIL_CC
EMAIL_SMTP_HOST, EMAIL_SMTP_PORT, EMAIL_SMTP_USER, EMAIL_SMTP_PASSWORD
```

## O que muda no novo sistema

- state.json → tabelas PostgreSQL (flight.DB)
- Script cron → flight.API agenda as buscas, scraping.API executa de forma assíncrona
- Uma rotina por usuário (até 10) substituem as env vars fixas
- Lógica de email/notificação migra para flight.API
- Template de email se mantém no mesmo estilo visual
- Unsubscribe token por email (main + CC separados)

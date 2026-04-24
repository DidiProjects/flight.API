---
name: Design aprovado — flight.API + flight.DB
description: Decisões de arquitetura, schema do banco e rotas dos novos projetos flight.API e flight.DB
type: project
---

## Arquitetura

- flight.API: container Docker, Node.js + Fastify, Linux
- flight.DB: container Docker, PostgreSQL 16, Linux
- scraping.API: VM Windows KVM no mesmo servidor Linux
- Comunicação: flight.API → scraping.API via HTTP (IP da VM: 192.168.122.224)

**Why:** separação de responsabilidades — scraping.API só raspa, flight.API gerencia usuários, rotinas, notificações e persistência.

## Schema (tabelas aprovadas)

7 tabelas: `users`, `password_reset_tokens`, `airlines`, `routines`, `flight_offers`, `best_fares`, `notification_log`, `unsubscribe_tokens`

Decisões importantes:
- **CC emails** → JSONB em `routines.cc_emails` (`[{email, subscribed}]`), não tabela separada
- **Scrape requests** → dois campos em `routines` (`pending_request_id UUID`, `pending_request_at TIMESTAMPTZ`), não tabela separada
- `flight_offers` referencia `routine_id` diretamente
- `best_fares`: UNIQUE(routine_id, date, is_return, fare_type) — 100 melhores por rotina
- Admin único via seed; roles: 'admin' | 'user'
- Senha provisória: validade 1 dia

## Fluxo de scrape

1. Scheduler (global, 1h + jitter randômico) busca rotinas ativas sem pending válido
2. Gera UUID → salva em `pending_request_id` + `pending_request_at` → POST /scrape no scraping.API
3. scraping.API ecoa `routineId` + `requestId` no callback POST /scrape/results
4. flight.API valida o par, persiste offers, atualiza best_fares, dispara notificações, zera pending

Pending expira em 1h (callback tardio é ignorado).

## Notificação

3 modos: `alert_only`, `daily_best_and_alert`, `end_of_period`
Frequência (campo obrigatório): `hourly` | `daily` | `monthly`
Anti-spam: só reenvia se preço melhorou vs último `notification_log`

## Unsubscribe

Token por email por envio, expira 1h após envio.
- CC: `cc_emails[].subscribed = false`
- Principal: `routines.is_active = false`

## Rotas principais

- POST /auth/login, /auth/change-password, /auth/forgot-password, /auth/reset-password/:token
- GET/POST/PATCH/DELETE /routines (máx 10 por usuário)
- GET /airlines
- GET/POST/PATCH/DELETE /users (admin only)
- POST /scrape/results (webhook interno, X-API-Key)
- GET /unsubscribe/:token (sem auth)
- GET /health

## Documento completo

`design.md` na raiz do repo scraping.API (branch develop).

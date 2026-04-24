# flight.API

REST API para monitoramento de preços de passagens aéreas. Recebe callbacks da scraping.API, avalia ofertas contra targets definidos pelo usuário e envia alertas por email.

## Stack

- **Runtime:** Node.js 22
- **Framework:** Fastify v5
- **Banco:** PostgreSQL 16 (gerenciado pelo flight.DB)
- **Linguagem:** TypeScript 5
- **Validação:** Zod v3
- **Auth:** JWT via `@fastify/jwt` + bcrypt para senhas
- **Email:** nodemailer

## Arquitetura

OOP com DI por construtor e interfaces separadas das implementações. Container manual em `src/container.ts` — sem frameworks de IoC.

```
src/
├── config/env.ts              # Validação de env vars via Zod
├── container.ts               # Wiring de dependências
├── db/pool.ts                 # pg.Pool compartilhado
├── modules/
│   ├── health/                # GET /health
│   ├── auth/                  # POST /auth/login, /change-password, /forgot-password, /reset-password/:token
│   ├── users/                 # CRUD de usuários (admin)
│   ├── airlines/              # GET /airlines
│   ├── routines/              # CRUD de rotinas de monitoramento
│   ├── scrape/                # POST /scrape/results (webhook da scraping.API)
│   └── unsubscribe/           # GET /unsubscribe/:token
├── services/
│   ├── email/                 # Envio de emails (nodemailer)
│   ├── notifications/         # Motor de alertas e tokens de unsubscribe
│   └── scheduler/             # Loop periódico + jobs diários
└── utils/
    ├── crypto.ts              # bcrypt, tokens, senha provisória
    └── errors.ts              # Classes de erro HTTP
```

Padrão por módulo:
```
modules/<domain>/
  interfaces/I<Domain>Repository.ts
  interfaces/I<Domain>Service.ts
  <Domain>Repository.ts
  <Domain>Service.ts
  route.ts                     # factory function(service) → Fastify plugin
  schema.ts                    # Zod schemas
```

## Variáveis de ambiente

```env
NODE_ENV=development
PORT=3011

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=
POSTGRES_PASSWORD=
POSTGRES_DB=flight

JWT_SECRET=                    # mínimo 32 chars
JWT_EXPIRES_IN=7d

SCRAPING_API_URL=
SCRAPING_API_KEY=
FLIGHT_API_KEY=                # chave que a scraping.API envia no header x-api-key
SCRAPE_INTERVAL_MS=3600000
SCRAPE_INTERVAL_JITTER_MS=300000

SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=

ADMIN_EMAIL=
ADMIN_PASSWORD_INITIAL=        # senha temporária, trocada no primeiro login

API_BASE_URL=http://localhost:3011   # usado nos links de unsubscribe nos emails
FRONTEND_URL=http://localhost:3000   # usado no link de reset de senha

LOG_LEVEL=debug
```

## Rodando localmente

```bash
npm install
cp .env.example .env           # ajustar variáveis
npm run start:dev
```

O banco precisa estar rodando via flight.DB antes de subir a API.

## Deploy

GitHub Actions → build Docker image → push via Tailscale SSH → `docker run` no servidor Linux.

A rede Docker `flight-network` conecta `flight-api` e `flight-db`. Container-to-container usa `POSTGRES_HOST=flight-db` e `POSTGRES_PORT=5432` (porta interna).

## Autenticação

JWT no header `Authorization: Bearer <token>`. Decorators disponíveis nas rotas:

| Decorator | Comportamento |
|---|---|
| `authenticate` | Valida o JWT |
| `requireAdmin` | Exige `role = admin` |
| `requirePasswordChanged` | Bloqueia se `mustChangePassword = true` |

## Webhook da scraping.API

`POST /scrape/results` com header `x-api-key: <FLIGHT_API_KEY>`. Payload validado via Zod, processado de forma assíncrona (responde 200 imediatamente).

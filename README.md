# flight.API

REST API for monitoring airline ticket prices. Receives callbacks from scraping.API, evaluates offers against user-defined targets, and sends email alerts.

## Stack

- **Runtime:** Node.js 22
- **Framework:** Fastify v5
- **Database:** PostgreSQL 16 (managed by flight.DB)
- **Language:** TypeScript 5
- **Validation:** Zod v3
- **Auth:** JWT via `@fastify/jwt` + bcrypt for passwords
- **Email:** nodemailer

## Architecture

OOP with constructor DI and interfaces separated from implementations. Manual container in `src/container.ts` — no IoC framework.

```
src/
├── config/env.ts              # Env var validation via Zod
├── container.ts               # Dependency wiring
├── db/pool.ts                 # Shared pg.Pool
├── modules/
│   ├── health/                # GET /health
│   ├── auth/                  # POST /auth/login, /change-password, /forgot-password, /reset-password/:token
│   ├── users/                 # User CRUD (admin)
│   ├── airlines/              # Airline management
│   ├── routines/              # Monitoring routine CRUD
│   ├── scrape/                # POST /scrape/results (scraping.API webhook)
│   └── unsubscribe/           # GET /unsubscribe/:token
├── services/
│   ├── email/                 # Email sending (nodemailer) + HTML templates
│   ├── notifications/         # Alert engine and unsubscribe tokens
│   └── scheduler/             # Periodic scrape loop + daily jobs
└── utils/
    ├── crypto.ts              # bcrypt, tokens, provisional password
    └── errors.ts              # HTTP error classes + structured error handler
```

Module pattern:
```
modules/<domain>/
  interfaces/I<Domain>Repository.ts
  interfaces/I<Domain>Service.ts
  <Domain>Repository.ts
  <Domain>Service.ts
  route.ts                     # factory function(service) → Fastify plugin
  schema.ts                    # Zod schemas
```

## Environment Variables

```env
NODE_ENV=development
PORT=3011

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=
POSTGRES_PASSWORD=
POSTGRES_DB=flight

JWT_SECRET=                    # minimum 32 chars
JWT_EXPIRES_IN=7d

SCRAPING_API_URL=
SCRAPING_API_KEY=
FLIGHT_API_KEY=                # key sent by scraping.API in the x-api-key header
SCRAPE_INTERVAL_MS=3600000
SCRAPE_INTERVAL_JITTER_MS=300000

SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=

ADMIN_EMAIL=
ADMIN_PASSWORD_INITIAL=        # temporary password, changed on first login

API_BASE_URL=http://localhost:3011   # used in unsubscribe links in emails
FRONTEND_URL=http://localhost:3000   # used in password reset link

LOG_LEVEL=debug
```

## Running Locally

```bash
npm install
cp .env.example .env           # fill in variables
npm run start:dev
```

The database must be running via flight.DB before starting the API.

## Deploy

GitHub Actions → build Docker image → push via Tailscale SSH → `docker run` on Linux server.

The Docker network `flight-network` connects `flight-api` and `flight-db`. Container-to-container uses `POSTGRES_HOST=flight-db` and `POSTGRES_PORT=5432` (internal port).

## Authentication

JWT in the `Authorization: Bearer <token>` header. Decorators available on routes:

| Decorator | Behavior |
|---|---|
| `authenticate` | Validates the JWT |
| `requireAdmin` | Requires `role = admin` |
| `requirePasswordChanged` | Blocks if `mustChangePassword = true` |

Admin routes check all three in sequence. Regular user routes check `authenticate` and `requirePasswordChanged` only.

## Endpoints

### Health
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | None | Liveness check |

### Auth
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/login` | None | Login, returns `accessToken` + `refreshToken` |
| POST | `/auth/refresh` | None | Refresh access token |
| POST | `/auth/logout` | Bearer | Revoke refresh token |
| POST | `/auth/change-password` | Bearer | Change password |
| POST | `/auth/forgot-password` | None | Send password reset email |
| POST | `/auth/reset-password/:token` | None | Reset password via token |

### Register
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | None | Request account (pending approval) |

### Users
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/users` | Admin | List users (paginated, filterable by status) |
| GET | `/users/:id` | Admin | Get user by ID |
| PATCH | `/users/:id/approve` | Admin | Approve user and assign role |
| PATCH | `/users/:id` | Admin | Update user |
| DELETE | `/users/:id` | Admin | Delete user |

### Airlines
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/airlines` | Bearer | List active airlines with available fare types |
| GET | `/airlines/admin` | Admin | List all airlines including inactive |
| POST | `/airlines` | Admin | Create airline |
| PATCH | `/airlines/:code/activate` | Admin | Activate airline |
| PATCH | `/airlines/:code/deactivate` | Admin | Deactivate airline |
| PATCH | `/airlines/:code/fare-types` | Admin | Update supported fare types (`hasBrl`, `hasPts`, `hasHyb`) |
| DELETE | `/airlines/:code` | Admin | Delete airline |

### Routines
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/routines` | Bearer | List authenticated user's routines |
| POST | `/routines` | Bearer | Create routine |
| GET | `/routines/:id` | Bearer | Get routine by ID |
| PATCH | `/routines/:id` | Bearer | Update routine |
| DELETE | `/routines/:id` | Bearer/Admin | Delete routine (admin bypasses ownership check) |
| PATCH | `/routines/:id/activate` | Bearer/Admin | Activate routine |
| PATCH | `/routines/:id/deactivate` | Bearer/Admin | Deactivate routine |
| GET | `/routines/admin/users/:userId` | Admin | List routines by user ID |
| POST | `/routines/:id/dispatch` | Admin | Manually trigger scrape for a routine |

### Scrape
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/scrape/results` | API Key | Webhook for scraping.API to deliver flight offers |

### Unsubscribe
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/unsubscribe/:token` | None | Unsubscribe email from routine alerts |

## scraping.API Webhook

`POST /scrape/results` with header `x-api-key: <FLIGHT_API_KEY>`. Payload validated via Zod, processed asynchronously (responds 200 immediately).

## Airline Deep Links

Email alerts include a direct link to the airline's booking page. Supported airlines:

| Code | BRL | Points / Hybrid |
|---|---|---|
| `azul` | `cc=BRL` | `cc=PTS` |
| `latam` | `redemption=false` | `redemption=true` |

Adding a new airline requires implementing a builder method in `EmailService` and adding a `case` in `buildDeepLink`.

# Design — flight.API + flight.DB

## Visão geral

Três projetos independentes, no mesmo servidor físico Linux:

```
Servidor Linux
├── container Docker: flight.API   (Node.js + Fastify)
├── container Docker: flight.DB    (PostgreSQL)
└── VM Windows (KVM):  scraping.API (Node.js + camoufox)
```

**Fluxo de uma análise:**
1. `flight.API` agenda buscas periódicas (intervalo global via `.env`, default 1h + margem randômica)
2. Para cada rotina ativa, gera um `requestId` (UUID), salva em `routines.pending_request_id` e dispara `POST /scrape` para `scraping.API`
3. `scraping.API` responde `202` imediatamente; scraping ocorre em fila
4. Ao concluir, `scraping.API` faz callback: `POST /scrape/results` → `flight.API` (ecoa `routineId` e `requestId`)
5. `flight.API` valida o par `requestId + routineId`, persiste em `flight.DB`, avalia notificações e dispara emails

---

## flight.DB — Schema PostgreSQL

### `users`
```sql
id                     UUID PRIMARY KEY DEFAULT gen_random_uuid()
email                  VARCHAR(255) UNIQUE NOT NULL
password_hash          VARCHAR(255) NOT NULL
role                   VARCHAR(10)  NOT NULL DEFAULT 'user'     -- 'admin' | 'user'
status                 VARCHAR(20)  NOT NULL DEFAULT 'pending'  -- 'pending' | 'active' | 'suspended'
must_change_password   BOOLEAN      NOT NULL DEFAULT true
provisional_expires_at TIMESTAMPTZ                              -- NULL após troca de senha
created_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
```
- Admin único: inserido via seed na inicialização do container
- `status = 'pending'` bloqueia acesso até admin aprovar
- `must_change_password = true` bloqueia endpoints (exceto `/auth/change-password`) até troca
- Senha provisória expira em 1 dia (`provisional_expires_at = created_at + 1 day`)

### `password_reset_tokens`
```sql
id         UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE
token      VARCHAR(128) UNIQUE NOT NULL  -- token aleatório seguro
expires_at TIMESTAMPTZ NOT NULL          -- now() + 1 day
used_at    TIMESTAMPTZ                   -- NULL = ainda válido
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

### `airlines`
```sql
code   VARCHAR(10) PRIMARY KEY  -- 'azul'
name   VARCHAR(100) NOT NULL    -- 'Azul Linhas Aéreas'
active BOOLEAN NOT NULL DEFAULT true
```
Seed inicial: `('azul', 'Azul Linhas Aéreas', true)`.

### `routines`
```sql
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE
name            VARCHAR(100) NOT NULL
airline         VARCHAR(10)  NOT NULL REFERENCES airlines(code)
origin          CHAR(3)      NOT NULL  -- IATA
destination     CHAR(3)      NOT NULL  -- IATA
outbound_start  DATE         NOT NULL
outbound_end    DATE         NOT NULL
return_start    DATE                   -- NULL = só ida
return_end      DATE
passengers      SMALLINT     NOT NULL DEFAULT 1
-- targets (pelo menos um deve estar preenchido)
target_brl      NUMERIC(10,2)
target_pts      INTEGER
target_hyb_pts  INTEGER
target_hyb_brl  NUMERIC(10,2)
margin          NUMERIC(4,3) NOT NULL DEFAULT 0.1  -- 0.1 = 10%
priority        VARCHAR(3)   NOT NULL DEFAULT 'brl' -- 'brl' | 'pts' | 'hyb'
-- notificação
notification_mode      VARCHAR(30)  NOT NULL  -- ver abaixo
notification_frequency VARCHAR(10)  NOT NULL  -- 'hourly' | 'daily' | 'monthly'
end_of_period_time     TIME                   -- usado apenas no modo 'end_of_period'
-- emails CC (JSONB array de objetos {email, subscribed})
cc_emails       JSONB        NOT NULL DEFAULT '[]'
-- controle de scrape pendente
pending_request_id  UUID            -- requestId enviado ao scraping.API
pending_request_at  TIMESTAMPTZ     -- para calcular expiração (> 1h = ignorar callback tardio)
is_active       BOOLEAN      NOT NULL DEFAULT true
created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
```

**`notification_mode`:**
- `'daily_best_and_alert'` — email diário com melhor preço vs target + alerta imediato quando target for superado
- `'alert_only'` — email apenas quando target for superado
- `'end_of_period'` — um único email no horário definido em `end_of_period_time`, ao final do período

**`cc_emails` (exemplo):**
```json
[
  { "email": "copia@exemplo.com", "subscribed": true },
  { "email": "outro@exemplo.com", "subscribed": false }
]
```
Ao desinscrever um CC via token: atualiza o objeto correspondente para `subscribed: false`.

**Controle de scrape pendente:**
- Ao despachar scrape: `pending_request_id = novo UUID`, `pending_request_at = now()`
- Ao receber callback: valida `requestId` + `routineId`, zera ambos os campos
- Callback com `pending_request_at < now() - 1h` → ignorado (expirado)
- Scheduler não despacha nova busca se `pending_request_id IS NOT NULL AND pending_request_at > now() - 1h`

### `flight_offers`
```sql
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
routine_id            UUID        NOT NULL REFERENCES routines(id) ON DELETE CASCADE
airline               VARCHAR(10) NOT NULL
flight_number         VARCHAR(10) NOT NULL
date                  DATE        NOT NULL
is_return             BOOLEAN     NOT NULL DEFAULT false
origin_iata           CHAR(3)     NOT NULL
origin_timestamp      TIMESTAMPTZ NOT NULL  -- ISO 8601 com offset de fuso
destination_iata      CHAR(3)     NOT NULL
destination_timestamp TIMESTAMPTZ NOT NULL
duration_min          INTEGER     NOT NULL
stops                 SMALLINT    NOT NULL DEFAULT 0
fare_brl              NUMERIC(10,2)
fare_pts              INTEGER
fare_hyb_pts          INTEGER
fare_hyb_brl          NUMERIC(10,2)
within_target         BOOLEAN     NOT NULL DEFAULT false
scraped_at            TIMESTAMPTZ NOT NULL
created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
```
**Regra de validação ao receber do scraping.API:**
- Descartar oferta onde `fare_brl IS NULL AND fare_pts IS NULL AND fare_hyb_pts IS NULL`
- Oferta com apenas alguns fares preenchidos é válida
- `error` no callback + `flights: []` → logar e zerar `pending_request_id`, não lançar erro

### `best_fares` (estado acumulado por rotina)
```sql
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
routine_id      UUID        NOT NULL REFERENCES routines(id) ON DELETE CASCADE
date            DATE        NOT NULL
is_return       BOOLEAN     NOT NULL DEFAULT false
fare_type       VARCHAR(3)  NOT NULL  -- 'brl' | 'pts' | 'hyb'
amount          NUMERIC(12,2) NOT NULL  -- valor comparável (BRL, pontos, ou pontos do híbrido)
flight_offer_id UUID        NOT NULL REFERENCES flight_offers(id) ON DELETE CASCADE
updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()

UNIQUE(routine_id, date, is_return, fare_type)
```
Mantém as 100 melhores passagens por rotina (menor amount por combinação rotina/data/direção/tipo).

### `notification_log`
```sql
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
routine_id      UUID        NOT NULL REFERENCES routines(id) ON DELETE CASCADE
type            VARCHAR(20) NOT NULL  -- 'alert' | 'best_of_day' | 'end_of_period'
fare_type       VARCHAR(3)  NOT NULL  -- 'brl' | 'pts' | 'hyb'
outbound_amount NUMERIC(12,2)
return_amount   NUMERIC(12,2)
email_to        VARCHAR(255) NOT NULL
email_cc        TEXT                  -- CSV dos CCs ativos no momento do envio
sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
```
Usado para anti-spam: só reenvia alerta se o preço melhorou vs último registro desta rotina.

### `unsubscribe_tokens`
```sql
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
token       VARCHAR(128) UNIQUE NOT NULL  -- token aleatório, 64+ chars
routine_id  UUID         NOT NULL REFERENCES routines(id) ON DELETE CASCADE
email       VARCHAR(255) NOT NULL   -- email específico a desinscrever
is_primary  BOOLEAN      NOT NULL DEFAULT false  -- true = email do usuário dono da rotina
expires_at  TIMESTAMPTZ  NOT NULL   -- sent_at + 1 hour
used_at     TIMESTAMPTZ
created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
```
Um token por email por envio. Ao usar:
- `is_primary = false` → atualiza objeto em `routines.cc_emails` para `subscribed: false`
- `is_primary = true` → desativa `routines.is_active = false` para o usuário desta rotina

---

## flight.API — Rotas

### Autenticação

Todos os endpoints (exceto `/health`, `/unsubscribe/:token` e `/auth/*`) exigem:
```
Authorization: Bearer <JWT>
```
JWT contém: `{ sub: userId, role, email }`. Expiração configurável (default 7 dias).

Usuários com `must_change_password = true` só acessam `/auth/change-password` e `/auth/logout`.

---

### `/auth`

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/auth/login` | Login com email + senha. Retorna JWT. |
| POST | `/auth/change-password` | Troca senha (obrigatório na primeira entrada). |
| POST | `/auth/forgot-password` | Envia email com link de recuperação. |
| POST | `/auth/reset-password/:token` | Redefine senha via token. Invalida token após uso. |

---

### `/users` (admin only)

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/users` | Lista todos os usuários. |
| POST | `/users` | Cria usuário com email. Envia senha provisória por email. |
| PATCH | `/users/:id/approve` | Aprova cadastro, define role, ativa usuário. |
| PATCH | `/users/:id` | Atualiza role ou status. |
| DELETE | `/users/:id` | Remove usuário (não remove o admin). |

---

### `/airlines`

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/airlines` | Lista companhias ativas disponíveis para seleção. |

---

### `/routines`

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/routines` | Lista rotinas do usuário autenticado. |
| POST | `/routines` | Cria nova rotina (máx 10 por usuário). |
| GET | `/routines/:id` | Detalhes de uma rotina. |
| PATCH | `/routines/:id` | Atualiza rotina. |
| DELETE | `/routines/:id` | Remove rotina e dados associados. |
| PATCH | `/routines/:id/activate` | Ativa rotina. |
| PATCH | `/routines/:id/deactivate` | Pausa rotina. |

**POST/PATCH body:**
```json
{
  "name": "Lisboa Maio",
  "airline": "azul",
  "origin": "VCP",
  "destination": "LIS",
  "outboundStart": "2026-05-25",
  "outboundEnd": "2026-05-27",
  "returnStart": "2026-06-10",
  "returnEnd": "2026-06-12",
  "passengers": 1,
  "targetBrl": 3500,
  "targetPts": null,
  "targetHybPts": 18000,
  "targetHybBrl": 1500,
  "margin": 0.1,
  "priority": "brl",
  "notificationMode": "daily_best_and_alert",
  "notificationFrequency": "daily",
  "endOfPeriodTime": null,
  "ccEmails": ["outro@email.com"]
}
```

---

### `/scrape` (webhook interno)

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/scrape/results` | Recebe resultado assíncrono do scraping.API. Auth via `X-API-Key`. |

**Body esperado** (scraping.API ecoa `routineId` e `requestId`):
```json
{
  "requestId": "uuid",
  "routineId": "uuid",
  "origin": "VCP",
  "destination": "LIS",
  "flights": [...],
  "scrapedAt": "2026-04-24T10:00:00.000Z",
  "error": "mensagem opcional em caso de falha"
}
```

---

### `/unsubscribe`

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/unsubscribe/:token` | Desinscreve o email associado ao token. Sem autenticação. |

Responde com página HTML simples confirmando a desinscreição (ou erro se token inválido/expirado).

---

### `/health`

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/health` | Status da API e conexão com o banco. Sem autenticação. |

---

## flight.API — Módulos internos

### Scheduler
- Roda em background no processo do flight.API
- Intervalo configurável via `.env` (`SCRAPE_INTERVAL_MS`, default 3.600.000 = 1h)
- Margem randômica: `± SCRAPE_INTERVAL_JITTER_MS` (default 300.000 = 5min) para evitar padrão detectável
- A cada tick: busca todas as rotinas ativas sem scrape pendente válido, despacha uma busca por rotina
- Não despacha se `pending_request_id IS NOT NULL AND pending_request_at > now() - 1h`

### Scrape Request Manager
Ao receber callback `POST /scrape/results`:
1. Valida par `requestId + routineId` contra `routines.pending_request_id`
2. Verifica se não expirou (`pending_request_at > now() - 1h`)
3. Descarta ofertas sem nenhum fare
4. Insere válidas em `flight_offers`
5. Atualiza `best_fares` se o novo preço é menor que o acumulado
6. Avalia e dispara notificações (ver Notification Engine)
7. Zera `pending_request_id` e `pending_request_at` na rotina

### Notification Engine
Avalia, por rotina, se deve enviar email após cada resultado:

**`alert_only` / `daily_best_and_alert`:**
- Verifica se alguma oferta está `within_target = true`
- Compara com último `notification_log` da rotina
- Só envia se o preço melhorou vs último enviado (outbound ou return)
- No modo `daily_best_and_alert`: também envia resumo diário com melhor preço vs target

**`end_of_period`:**
- Não envia em tempo real
- Job diário no horário `end_of_period_time` verifica rotinas neste modo
- Envia uma vez com o melhor acumulado de `best_fares` do dia

### Email Service
- **Stack:** nodemailer + SMTP
- Todo email inclui link de unsubscribe individual por endereço (principal + cada CC subscribed)
- Token expira 1h após o envio
- `is_primary = true`: desinscreição desativa a rotina (`is_active = false`)
- `is_primary = false`: atualiza `cc_emails` JSONB para `subscribed: false` no endereço

**Template (mantém layout do projeto legado):**
- Header dark, body branco, footer com timestamp BRT
- Bloco por oferta: data, voo, partida, chegada, duração/escalas, tarifa, botão deep-link Azul
- Rodapé com link "Cancelar recebimento deste email" individual por endereço

---

## Variáveis de ambiente — flight.API

```
PORT=3011
DATABASE_URL=postgresql://user:pass@flight-db:5432/flightdb
JWT_SECRET=...
JWT_EXPIRES_IN=7d

SCRAPE_INTERVAL_MS=3600000
SCRAPE_INTERVAL_JITTER_MS=300000
SCRAPING_API_URL=http://192.168.122.224:3000
SCRAPING_API_KEY=...
FLIGHT_API_KEY=...          # chave que scraping.API usa para autenticar o callback

SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM="flight.API <noreply@...>"

ADMIN_EMAIL=...
ADMIN_PASSWORD_INITIAL=...  # senha provisória do admin no seed
LOG_LEVEL=info
```

---

## Deploy

**flight.DB:**
```yaml
flight-db:
  image: postgres:16
  environment:
    POSTGRES_DB: flightdb
    POSTGRES_USER: ...
    POSTGRES_PASSWORD: ...
  volumes:
    - pgdata:/var/lib/postgresql/data
  restart: unless-stopped
```

**flight.API:**
```yaml
flight-api:
  build: .
  depends_on: [flight-db]
  env_file: .env
  ports:
    - "3011:3001"
  restart: unless-stopped
```

Migrações via script SQL rodando no startup do container.

import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3011),

  POSTGRES_HOST: z.string(),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_USER: z.string(),
  POSTGRES_PASSWORD: z.string(),
  POSTGRES_DB: z.string(),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  SCRAPE_INTERVAL_MS: z.coerce.number().default(300_000),
  SCRAPE_INTERVAL_JITTER_MS: z.coerce.number().default(60_000),
  // How many jobs per airline to dispatch each tick. NOTE: in practice this is the
  // number of SIMULTANEOUS Playwright sessions against the same site, from the same
  // IP — high values are a strong bot signal. Conservative default (1) for stealth;
  // only raise it with per-airline concurrency/IP rotation in the scraper.
  SCRAPE_DISPATCH_BATCH: z.coerce.number().int().positive().default(1),
  // Ceiling of in-flight jobs (≈ scraper capacity). The API claims no more than this
  // — backpressure, so the scraper queue is not inflated.
  SCRAPE_MAX_IN_FLIGHT: z.coerce.number().int().positive().default(6),
  // Ceiling of in-flight jobs PER AIRLINE. Two automated sessions on the same site,
  // from the same IP, at the same time: on 2026-08-20 all nine LATAM failures had
  // another LATAM session in parallel, and the only collection that passed was the
  // one that started first. With the global ceiling at 6 and the scraper queue at 2,
  // limiting to 1 per airline does not cut throughput when routes span airlines — it
  // cuts only when the whole queue is one airline, which is exactly the case to avoid.
  SCRAPE_MAX_IN_FLIGHT_PER_AIRLINE: z.coerce.number().int().positive().default(1),
  EVALUATION_INTERVAL_MS: z.coerce.number().default(5 * 60 * 1000),

  // Exchange. The timeout is short on purpose: the evaluation cycle cannot hang on a
  // third party, and the measured median of both APIs is ~120ms.
  FX_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  // Minimum improvement in Real to alert when the price composition changed.
  // Absorbs exchange noise; an identical composition already blocks the common case.
  FX_NOISE_MARGIN: z.coerce.number().min(0).max(0.5).default(0.01),
  SCRAPING_API_URL: z.string().url(),
  SCRAPING_API_KEY: z.string(),
  FLIGHT_API_KEY: z.string(),

  SMTP_HOST: z.string(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string(),
  SMTP_PASSWORD: z.string(),
  SMTP_FROM: z.string(),

  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD_INITIAL: z.string().min(8),

  API_BASE_URL: z.string().url().default('http://localhost:3011/flight'),
  FRONTEND_URL: z.string().url().default('http://localhost:3001'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  GRAFANA_LOKI_URL:   z.string().url().optional(),
  GRAFANA_LOKI_USER:  z.string().optional(),
  GRAFANA_LOKI_TOKEN: z.string().optional(),

  // Realtime (WS hub ← workers, SSE → admin)
  REALTIME_ENABLED: z.string().default('true'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Variáveis de ambiente inválidas:')
  parsed.error.issues.forEach((issue) => {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  })
  process.exit(1)
}

export const env = parsed.data
export type Env = typeof env

import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3011),

  POSTGRES_HOST: z.string(),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_USER: z.string(),
  POSTGRES_PASSWORD: z.string(),
  POSTGRES_DB: z.string(),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),

  SCRAPE_INTERVAL_MS: z.coerce.number().default(3_600_000),
  SCRAPE_INTERVAL_JITTER_MS: z.coerce.number().default(300_000),
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
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
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

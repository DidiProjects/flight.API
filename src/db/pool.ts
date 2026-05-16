import { Pool } from 'pg'
import { env } from '../config/env'
import { logger } from '../utils/logger'

export const pool = new Pool({
  host: env.POSTGRES_HOST,
  port: env.POSTGRES_PORT,
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DB,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
})

pool.on('error', (err) => {
  logger.error({ err }, 'pg pool error')
})

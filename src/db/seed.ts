import { pool } from './pool'
import { env } from '../config/env'
import { hashPassword } from '../utils/crypto'

export async function seed(): Promise<void> {
  await seedAirlines()
  await seedAdmin()
}

async function seedAirlines(): Promise<void> {
  await pool.query(`
    INSERT INTO airlines (code, name, active) VALUES
      ('azul', 'Azul Linhas Aéreas', true),
      ('gol',  'GOL Linhas Aéreas',  true),
      ('latam','LATAM Airlines',      true)
    ON CONFLICT (code) DO NOTHING
  `)
}

async function seedAdmin(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
  )
  if (rows.length > 0) return

  const passwordHash = hashPassword(env.ADMIN_PASSWORD_INITIAL)

  await pool.query(
    `INSERT INTO users (email, password_hash, role, status, must_change_password)
     VALUES ($1, $2, 'admin', 'active', true)`,
    [env.ADMIN_EMAIL, passwordHash],
  )

  console.log(`✅ Admin criado: ${env.ADMIN_EMAIL}`)
}

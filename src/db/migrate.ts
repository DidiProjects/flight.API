import { readFileSync } from 'fs'
import { join } from 'path'
import { pool } from './pool'

export async function migrate(): Promise<void> {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
  await pool.query(sql)
  console.log('✅ Migrations aplicadas')
}

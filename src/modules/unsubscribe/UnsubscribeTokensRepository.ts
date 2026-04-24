import { Pool } from 'pg'
import { UnsubscribeTokenRow } from '../../types'
import { IUnsubscribeTokensRepository } from './interfaces/IUnsubscribeTokensRepository'
import { generateToken } from '../../utils/crypto'

export class UnsubscribeTokensRepository implements IUnsubscribeTokensRepository {
  constructor(private readonly db: Pool) {}

  async create(routineId: string, email: string, isPrimary: boolean): Promise<string> {
    const token = generateToken(64)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await this.db.query(
      `INSERT INTO unsubscribe_tokens (token, routine_id, email, is_primary, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [token, routineId, email, isPrimary, expiresAt],
    )
    return token
  }

  async findByToken(token: string): Promise<UnsubscribeTokenRow | null> {
    const { rows } = await this.db.query<UnsubscribeTokenRow>(
      `SELECT ut.id, ut.token, ut.routine_id, r.name AS routine_name,
              ut.email, ut.is_primary, ut.expires_at, ut.used_at, ut.created_at
       FROM unsubscribe_tokens ut
       JOIN routines r ON r.id = ut.routine_id
       WHERE ut.token = $1`,
      [token],
    )
    return rows[0] ?? null
  }

  async markUsed(id: string): Promise<void> {
    await this.db.query(
      `UPDATE unsubscribe_tokens SET used_at = now() WHERE id = $1`,
      [id],
    )
  }
}

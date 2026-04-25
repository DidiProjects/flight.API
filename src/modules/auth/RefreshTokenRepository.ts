import { Pool } from 'pg'
import { RefreshTokenRow } from '../../types'
import { IRefreshTokenRepository } from './interfaces/IRefreshTokenRepository'

export class RefreshTokenRepository implements IRefreshTokenRepository {
  constructor(private readonly db: Pool) {}

  async create(userId: string, token: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [userId, token, expiresAt],
    )
  }

  async findByToken(token: string): Promise<RefreshTokenRow | null> {
    const { rows } = await this.db.query<RefreshTokenRow>(
      `SELECT id, user_id, token, expires_at, used_at, revoked_at, created_at
       FROM refresh_tokens WHERE token = $1`,
      [token],
    )
    return rows[0] ?? null
  }

  async markUsed(id: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens SET used_at = now() WHERE id = $1`,
      [id],
    )
  }

  async revoke(token: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE token = $1`,
      [token],
    )
  }
}

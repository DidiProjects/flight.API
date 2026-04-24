import { Pool } from 'pg'
import { PasswordResetTokenRow } from '../../types'
import { IPasswordResetRepository } from './interfaces/IPasswordResetRepository'

export class AuthRepository implements IPasswordResetRepository {
  constructor(private readonly db: Pool) {}

  async create(userId: string, token: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [userId, token, expiresAt],
    )
  }

  async findByToken(token: string): Promise<PasswordResetTokenRow | null> {
    const { rows } = await this.db.query<PasswordResetTokenRow>(
      `SELECT id, user_id, token, expires_at, used_at, created_at
       FROM password_reset_tokens WHERE token = $1`,
      [token],
    )
    return rows[0] ?? null
  }

  async markUsed(id: string): Promise<void> {
    await this.db.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`,
      [id],
    )
  }
}

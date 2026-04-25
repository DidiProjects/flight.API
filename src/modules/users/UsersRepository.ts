import { Pool } from 'pg'
import { UserRow } from '../../types'
import { IUsersRepository, CreateUserData } from './interfaces/IUsersRepository'

const COLS = `id, email, name, password_hash, role, status,
              must_change_password, provisional_expires_at, created_at, updated_at`

export class UsersRepository implements IUsersRepository {
  constructor(private readonly db: Pool) {}

  async findAll(page: number, limit: number, status?: string): Promise<{ users: UserRow[]; total: number }> {
    const offset = (page - 1) * limit
    const where  = status ? `WHERE status = $3` : ''
    const params = status ? [limit, offset, status] : [limit, offset]

    const [{ rows: users }, { rows: count }] = await Promise.all([
      this.db.query<UserRow>(
        `SELECT ${COLS} FROM users ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        params,
      ),
      this.db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM users ${where}`,
        status ? [status] : [],
      ),
    ])
    return { users, total: parseInt(count[0].total) }
  }

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT ${COLS} FROM users WHERE id = $1`,
      [id],
    )
    return rows[0] ?? null
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT ${COLS} FROM users WHERE email = $1`,
      [email],
    )
    return rows[0] ?? null
  }

  async create(data: CreateUserData): Promise<UserRow> {
    const { email, passwordHash, name = null } = data
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO users (email, name, password_hash, status, must_change_password)
       VALUES ($1, $2, $3, 'pending', true)
       RETURNING ${COLS}`,
      [email, name, passwordHash],
    )
    return rows[0]
  }

  async approve(id: string, role: 'admin' | 'user'): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>(
      `UPDATE users SET role = $1, status = 'active', updated_at = now()
       WHERE id = $2 AND status = 'pending'
       RETURNING ${COLS}`,
      [role, id],
    )
    return rows[0] ?? null
  }

  async update(id: string, fields: { role?: string; status?: string }): Promise<UserRow | null> {
    const updates: string[] = []
    const values: unknown[] = []
    let i = 1
    if (fields.role)   { updates.push(`role = $${i++}`);   values.push(fields.role) }
    if (fields.status) { updates.push(`status = $${i++}`); values.push(fields.status) }
    if (updates.length === 0) return this.findById(id)
    updates.push(`updated_at = now()`)
    values.push(id)
    const { rows } = await this.db.query<UserRow>(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i} RETURNING ${COLS}`,
      values,
    )
    return rows[0] ?? null
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.db.query(
      `UPDATE users
       SET password_hash = $1, must_change_password = false, provisional_expires_at = NULL, updated_at = now()
       WHERE id = $2`,
      [passwordHash, id],
    )
  }

  async setProvisionalPassword(id: string, passwordHash: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE users
       SET password_hash = $1, must_change_password = true, provisional_expires_at = $2, updated_at = now()
       WHERE id = $3`,
      [passwordHash, expiresAt, id],
    )
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM users WHERE id = $1 AND role != 'admin'`,
      [id],
    )
    return (rowCount ?? 0) > 0
  }
}

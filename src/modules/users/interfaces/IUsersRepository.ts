import { UserRow } from '../../../types'

export interface IUsersRepository {
  findAll(page: number, limit: number): Promise<{ users: UserRow[]; total: number }>
  findById(id: string): Promise<UserRow | null>
  findByEmail(email: string): Promise<UserRow | null>
  create(email: string, passwordHash: string): Promise<UserRow>
  approve(id: string, role: 'admin' | 'user'): Promise<UserRow | null>
  update(id: string, fields: { role?: string; status?: string }): Promise<UserRow | null>
  updatePassword(id: string, passwordHash: string): Promise<void>
  delete(id: string): Promise<boolean>
}

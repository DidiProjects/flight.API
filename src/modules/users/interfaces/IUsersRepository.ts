import { UserRow } from '../../../types'

export interface CreateUserData {
  email: string
  passwordHash: string
  name?: string
}

export interface IUsersRepository {
  findAll(page: number, limit: number, status?: string): Promise<{ users: UserRow[]; total: number }>
  findById(id: string): Promise<UserRow | null>
  findByEmail(email: string): Promise<UserRow | null>
  create(data: CreateUserData): Promise<UserRow>
  approve(id: string, role: 'admin' | 'user'): Promise<UserRow | null>
  update(id: string, fields: { role?: string; status?: string }): Promise<UserRow | null>
  updatePassword(id: string, passwordHash: string): Promise<void>
  setProvisionalPassword(id: string, passwordHash: string, expiresAt: Date): Promise<void>
  delete(id: string): Promise<boolean>
}

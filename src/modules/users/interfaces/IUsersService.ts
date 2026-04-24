import { UserRow } from '../../../types'

export interface IUsersService {
  list(page: number, limit: number): Promise<{ users: UserRow[]; total: number }>
  getById(id: string): Promise<UserRow>
  register(email: string): Promise<void>
  approve(id: string, role: 'admin' | 'user'): Promise<void>
  update(
    id: string,
    fields: { role?: 'admin' | 'user'; status?: 'active' | 'suspended' },
    requesterId: string,
  ): Promise<void>
  remove(id: string, requesterId: string): Promise<void>
}

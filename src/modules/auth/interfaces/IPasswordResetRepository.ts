import { PasswordResetTokenRow } from '../../../types'

export interface IPasswordResetRepository {
  create(userId: string, token: string, expiresAt: Date): Promise<void>
  findByToken(token: string): Promise<PasswordResetTokenRow | null>
  markUsed(id: string): Promise<void>
}

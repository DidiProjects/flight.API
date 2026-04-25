import { RefreshTokenRow } from '../../../types'

export interface IRefreshTokenRepository {
  create(userId: string, token: string, expiresAt: Date): Promise<void>
  findByToken(token: string): Promise<RefreshTokenRow | null>
  markUsed(id: string): Promise<void>
  revoke(token: string): Promise<void>
}

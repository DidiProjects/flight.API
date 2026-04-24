import { UnsubscribeTokenRow } from '../../../types'

export interface IUnsubscribeTokensRepository {
  create(routineId: string, email: string, isPrimary: boolean): Promise<string>
  findByToken(token: string): Promise<UnsubscribeTokenRow | null>
  markUsed(id: string): Promise<void>
}

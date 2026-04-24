import { UserRow } from '../../../types'

export interface IAuthService {
  login(email: string, password: string): Promise<UserRow>
  changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void>
  forgotPassword(email: string): Promise<void>
  resetPassword(token: string, newPassword: string): Promise<void>
}

import { UserRow } from '../../../types'

export interface IAuthService {
  login(email: string, password: string): Promise<UserRow>
  generateRefreshToken(userId: string): Promise<string>
  refresh(token: string): Promise<{ user: UserRow; newRefreshToken: string }>
  logout(token: string): Promise<void>
  changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void>
  forgotPassword(email: string): Promise<void>
  resetPassword(token: string, newPassword: string): Promise<void>
}

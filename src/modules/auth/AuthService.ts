import { UserRow } from '../../types'
import { IAuthService } from './interfaces/IAuthService'
import { IUsersRepository } from '../users/interfaces/IUsersRepository'
import { IPasswordResetRepository } from './interfaces/IPasswordResetRepository'
import { IRefreshTokenRepository } from './interfaces/IRefreshTokenRepository'
import { IEmailService } from '../../services/email/interfaces/IEmailService'
import { verifyPassword, hashPassword, generateToken } from '../../utils/crypto'
import {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  BadRequestError,
} from '../../utils/errors'
import { env } from '../../config/env'

function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d)$/)
  if (!match) throw new Error(`Duração inválida: ${duration}`)
  const value = parseInt(match[1])
  const multipliers: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return value * multipliers[match[2]]
}

export class AuthService implements IAuthService {
  constructor(
    private readonly usersRepo: IUsersRepository,
    private readonly passwordResetRepo: IPasswordResetRepository,
    private readonly refreshTokenRepo: IRefreshTokenRepository,
    private readonly emailSvc: IEmailService,
  ) {}

  async login(email: string, password: string): Promise<UserRow> {
    const user = await this.usersRepo.findByEmail(email)

    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new UnauthorizedError('Credenciais inválidas')
    }
    if (user.status === 'pending') {
      throw new ForbiddenError('Conta aguardando aprovação do administrador')
    }
    if (user.status === 'suspended') {
      throw new ForbiddenError('Conta suspensa')
    }
    if (
      user.must_change_password &&
      user.provisional_expires_at &&
      user.provisional_expires_at < new Date()
    ) {
      throw new ForbiddenError('Senha provisória expirada. Solicite uma nova ao administrador.')
    }

    return user
  }

  async generateRefreshToken(userId: string): Promise<string> {
    const token = generateToken(64)
    const expiresAt = new Date(Date.now() + parseDurationMs(env.JWT_REFRESH_EXPIRES_IN))
    await this.refreshTokenRepo.create(userId, token, expiresAt)
    return token
  }

  async refresh(token: string): Promise<{ user: UserRow; newRefreshToken: string }> {
    const rec = await this.refreshTokenRepo.findByToken(token)
    if (!rec)           throw new UnauthorizedError('Refresh token inválido')
    if (rec.used_at)    throw new UnauthorizedError('Refresh token já utilizado')
    if (rec.revoked_at) throw new UnauthorizedError('Refresh token revogado')
    if (rec.expires_at < new Date()) throw new UnauthorizedError('Refresh token expirado')

    const user = await this.usersRepo.findById(rec.user_id)
    if (!user || user.status !== 'active') throw new UnauthorizedError('Usuário inativo')

    await this.refreshTokenRepo.markUsed(rec.id)
    const newRefreshToken = await this.generateRefreshToken(rec.user_id)

    return { user, newRefreshToken }
  }

  async logout(token: string): Promise<void> {
    await this.refreshTokenRepo.revoke(token)
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.usersRepo.findById(userId)
    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      throw new UnauthorizedError('Senha atual incorreta')
    }
    await this.usersRepo.updatePassword(userId, hashPassword(newPassword))
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersRepo.findByEmail(email)
    if (!user || user.status !== 'active') return // não revelar se o email existe

    const token   = generateToken(48)
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)

    await this.passwordResetRepo.create(user.id, token, expires)
    await this.emailSvc.sendPasswordReset(email, token)
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const rec = await this.passwordResetRepo.findByToken(token)
    if (!rec)        throw new NotFoundError('Token inválido')
    if (rec.used_at) throw new BadRequestError('Token já utilizado')
    if (rec.expires_at < new Date()) throw new BadRequestError('Token expirado')

    await this.usersRepo.updatePassword(rec.user_id, hashPassword(newPassword))
    await this.passwordResetRepo.markUsed(rec.id)
  }
}

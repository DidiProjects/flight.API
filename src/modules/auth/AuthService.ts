import { UserRow } from '../../types'
import { IAuthService } from './interfaces/IAuthService'
import { IUsersRepository } from '../users/interfaces/IUsersRepository'
import { IPasswordResetRepository } from './interfaces/IPasswordResetRepository'
import { IEmailService } from '../../services/email/interfaces/IEmailService'
import { verifyPassword, hashPassword, generateToken } from '../../utils/crypto'
import {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  BadRequestError,
} from '../../utils/errors'

export class AuthService implements IAuthService {
  constructor(
    private readonly usersRepo: IUsersRepository,
    private readonly passwordResetRepo: IPasswordResetRepository,
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

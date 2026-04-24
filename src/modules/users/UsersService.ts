import { UserRow } from '../../types'
import { IUsersService } from './interfaces/IUsersService'
import { IUsersRepository } from './interfaces/IUsersRepository'
import { IEmailService } from '../../services/email/interfaces/IEmailService'
import { hashPassword, generateProvisionalPassword } from '../../utils/crypto'
import {
  ConflictError,
  NotFoundError,
  ForbiddenError,
  BadRequestError,
} from '../../utils/errors'

export class UsersService implements IUsersService {
  constructor(
    private readonly usersRepo: IUsersRepository,
    private readonly emailSvc: IEmailService,
  ) {}

  async list(page: number, limit: number): Promise<{ users: UserRow[]; total: number }> {
    return this.usersRepo.findAll(page, limit)
  }

  async getById(id: string): Promise<UserRow> {
    const user = await this.usersRepo.findById(id)
    if (!user) throw new NotFoundError('Usuário não encontrado')
    return user
  }

  async register(email: string): Promise<void> {
    const existing = await this.usersRepo.findByEmail(email)
    if (existing) throw new ConflictError('Email já cadastrado')

    const provisional = generateProvisionalPassword()
    await this.usersRepo.create(email, hashPassword(provisional))
    await this.emailSvc.sendProvisionalPassword(email, provisional)
  }

  async approve(id: string, role: 'admin' | 'user'): Promise<void> {
    const user = await this.usersRepo.findById(id)
    if (!user) throw new NotFoundError('Usuário não encontrado')
    if (user.status !== 'pending') throw new BadRequestError('Usuário não está pendente')

    const updated = await this.usersRepo.approve(id, role)
    if (!updated) throw new NotFoundError('Usuário não encontrado')

    await this.emailSvc.sendUserApproved(user.email)
  }

  async update(
    id: string,
    fields: { role?: 'admin' | 'user'; status?: 'active' | 'suspended' },
    requesterId: string,
  ): Promise<void> {
    const user = await this.usersRepo.findById(id)
    if (!user) throw new NotFoundError('Usuário não encontrado')
    if (user.role === 'admin' && id !== requesterId) {
      throw new ForbiddenError('Não é possível editar outro administrador')
    }
    await this.usersRepo.update(id, fields)
  }

  async remove(id: string, requesterId: string): Promise<void> {
    if (id === requesterId) throw new ForbiddenError('Não é possível remover a própria conta')
    const user = await this.usersRepo.findById(id)
    if (!user) throw new NotFoundError('Usuário não encontrado')
    if (user.role === 'admin') throw new ForbiddenError('Não é possível remover o administrador')
    const deleted = await this.usersRepo.delete(id)
    if (!deleted) throw new NotFoundError('Usuário não encontrado')
  }
}

import { RoutineRow } from '../../types'
import { IRoutinesService } from './interfaces/IRoutinesService'
import { IRoutinesRepository, CreateRoutineData } from './interfaces/IRoutinesRepository'
import { IAirlinesRepository } from '../airlines/interfaces/IAirlinesRepository'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors'

const MAX_ROUTINES = 10

export class RoutinesService implements IRoutinesService {
  constructor(
    private readonly routinesRepo: IRoutinesRepository,
    private readonly airlinesRepo: IAirlinesRepository,
  ) {}

  async list(userId: string): Promise<RoutineRow[]> {
    return this.routinesRepo.findByUser(userId)
  }

  async listByUser(userId: string): Promise<RoutineRow[]> {
    return this.routinesRepo.findByUser(userId)
  }

  async get(id: string, userId: string): Promise<RoutineRow> {
    const routine = await this.routinesRepo.findById(id, userId)
    if (!routine) throw new NotFoundError('Rotina não encontrada')
    return routine
  }

  async create(userId: string, data: Omit<CreateRoutineData, 'userId' | 'currency'>): Promise<RoutineRow> {
    const count = await this.routinesRepo.countByUser(userId)
    if (count >= MAX_ROUTINES) {
      throw new ForbiddenError(`Limite de ${MAX_ROUTINES} rotinas por usuário atingido`)
    }

    const airlineRows = []
    for (const code of data.airlines) {
      const airline = await this.airlinesRepo.findByCode(code)
      if (!airline || !airline.active) throw new BadRequestError(`Companhia '${code}' não disponível`)
      airlineRows.push(airline)
    }

    const currencies = [...new Set(airlineRows.map((a) => a.currency).filter(Boolean))]
    if (currencies.length > 1) {
      throw new BadRequestError(
        `Todas as companhias devem usar a mesma moeda (${airlineRows.map((a) => `${a.code}=${a.currency}`).join(', ')})`,
      )
    }
    const currency = currencies[0]
    if (!currency) throw new BadRequestError('Companhia sem moeda configurada')

    const today = new Date().toISOString().slice(0, 10)
    if (data.outboundEnd < today) {
      throw new BadRequestError('A data de ida já passou')
    }
    if (data.returnEnd && data.returnEnd < today) {
      throw new BadRequestError('A data de volta já passou')
    }
    if (data.outboundStart > data.outboundEnd) {
      throw new BadRequestError('outboundStart deve ser anterior a outboundEnd')
    }
    if (data.returnStart && data.returnEnd && data.returnStart > data.returnEnd) {
      throw new BadRequestError('returnStart deve ser anterior a returnEnd')
    }

    return this.routinesRepo.create({ userId, ...data, currency })
  }

  async update(
    id: string,
    userId: string,
    fields: Partial<Omit<CreateRoutineData, 'userId'>>,
  ): Promise<RoutineRow> {
    const existing = await this.routinesRepo.findById(id, userId)
    if (!existing) throw new NotFoundError('Rotina não encontrada')

    if (fields.airlines && fields.airlines.length > 0) {
      const airlineRows = []
      for (const code of fields.airlines) {
        const airline = await this.airlinesRepo.findByCode(code)
        if (!airline || !airline.active) throw new BadRequestError(`Companhia '${code}' não disponível`)
        airlineRows.push(airline)
      }
      const currencies = [...new Set(airlineRows.map((a) => a.currency).filter(Boolean))]
      if (currencies.length > 1) {
        throw new BadRequestError(
          `Todas as companhias devem usar a mesma moeda (${airlineRows.map((a) => `${a.code}=${a.currency}`).join(', ')})`,
        )
      }
      const updateCurrency = currencies[0]
      if (!updateCurrency) throw new BadRequestError('Companhia sem moeda configurada')
      fields = { ...fields, currency: updateCurrency }
    }

    const updated = await this.routinesRepo.update(id, userId, fields)
    if (!updated) throw new NotFoundError('Rotina não encontrada')
    return updated
  }

  async remove(id: string, userId: string): Promise<void> {
    const existing = await this.routinesRepo.findById(id, userId)
    if (!existing) throw new NotFoundError('Rotina não encontrada')
    const deleted = await this.routinesRepo.delete(id, userId)
    if (!deleted) throw new NotFoundError('Rotina não encontrada')
  }

  async activate(id: string, userId: string): Promise<RoutineRow> {
    const existing = await this.routinesRepo.findById(id, userId)
    if (!existing) throw new NotFoundError('Rotina não encontrada')
    const today = new Date().toISOString().slice(0, 10)
    if (String(existing.outbound_end).slice(0, 10) < today) {
      throw new BadRequestError('Não é possível ativar uma rotina com data de ida no passado')
    }
    if (existing.return_end && String(existing.return_end).slice(0, 10) < today) {
      throw new BadRequestError('Não é possível ativar uma rotina com data de volta no passado')
    }
    for (const code of existing.airlines) {
      const airline = await this.airlinesRepo.findByCode(code)
      if (!airline?.active) throw new BadRequestError(`Companhia '${code}' está desativada`)
    }
    const routine = await this.routinesRepo.setActive(id, userId, true)
    if (!routine) throw new NotFoundError('Rotina não encontrada')
    return routine
  }

  async deactivate(id: string, userId: string): Promise<RoutineRow> {
    const routine = await this.routinesRepo.setActive(id, userId, false)
    if (!routine) throw new NotFoundError('Rotina não encontrada')
    return routine
  }

  async adminUpdateRoutine(
    id: string,
    fields: Partial<Omit<CreateRoutineData, 'userId'>>,
  ): Promise<RoutineRow> {
    const existing = await this.routinesRepo.findByIdAdmin(id)
    if (!existing) throw new NotFoundError('Rotina não encontrada')

    if (fields.airlines && fields.airlines.length > 0) {
      const airlineRows = []
      for (const code of fields.airlines) {
        const airline = await this.airlinesRepo.findByCode(code)
        if (!airline || !airline.active) throw new BadRequestError(`Companhia '${code}' não disponível`)
        airlineRows.push(airline)
      }
      const currencies = [...new Set(airlineRows.map((a) => a.currency).filter(Boolean))]
      if (currencies.length > 1) {
        throw new BadRequestError(
          `Todas as companhias devem usar a mesma moeda (${airlineRows.map((a) => `${a.code}=${a.currency}`).join(', ')})`,
        )
      }
      const updateCurrency = currencies[0]
      if (!updateCurrency) throw new BadRequestError('Companhia sem moeda configurada')
      fields = { ...fields, currency: updateCurrency }
    }

    const updated = await this.routinesRepo.updateById(id, fields)
    if (!updated) throw new NotFoundError('Rotina não encontrada')
    return updated
  }

  async adminActivate(id: string): Promise<RoutineRow> {
    const existing = await this.routinesRepo.findByIdAdmin(id)
    if (!existing) throw new NotFoundError('Rotina não encontrada')
    const today = new Date().toISOString().slice(0, 10)
    if (String(existing.outbound_end).slice(0, 10) < today) {
      throw new BadRequestError('Não é possível ativar uma rotina com data de ida no passado')
    }
    if (existing.return_end && String(existing.return_end).slice(0, 10) < today) {
      throw new BadRequestError('Não é possível ativar uma rotina com data de volta no passado')
    }
    for (const code of existing.airlines) {
      const airline = await this.airlinesRepo.findByCode(code)
      if (!airline?.active) throw new BadRequestError(`Companhia '${code}' está desativada`)
    }
    const routine = await this.routinesRepo.setActiveAdmin(id, true)
    if (!routine) throw new NotFoundError('Rotina não encontrada')
    return routine
  }

  async adminDeactivate(id: string): Promise<RoutineRow> {
    const routine = await this.routinesRepo.setActiveAdmin(id, false)
    if (!routine) throw new NotFoundError('Rotina não encontrada')
    return routine
  }

  async adminRemove(id: string): Promise<void> {
    const deleted = await this.routinesRepo.deleteAdmin(id)
    if (!deleted) throw new NotFoundError('Rotina não encontrada')
  }
}

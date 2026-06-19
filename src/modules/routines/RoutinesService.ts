import { RoutineRow } from '../../types'
import { IRoutinesService } from './interfaces/IRoutinesService'
import { IRoutinesRepository, CreateRoutineData } from './interfaces/IRoutinesRepository'
import { IAirlinesRepository } from '../airlines/interfaces/IAirlinesRepository'
import { IAirportsRepository } from '../airports/interfaces/IAirportsRepository'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors'

const MAX_ROUTINES = 10

export class RoutinesService implements IRoutinesService {
  constructor(
    private readonly routinesRepo: IRoutinesRepository,
    private readonly airlinesRepo: IAirlinesRepository,
    private readonly airportsRepo: IAirportsRepository,
  ) {}

  /**
   * Moeda da rotina = moeda do mercado da ORIGEM (ponto de venda).
   * Resolvida por airports.currency(airline, origin) para cada companhia.
   * Todas as companhias precisam resolver a mesma moeda na origem.
   */
  private async resolveCurrencyByOrigin(airlines: string[], origin: string): Promise<string> {
    const resolved: { airline: string; currency: string | null }[] = []
    for (const code of airlines) {
      resolved.push({ airline: code, currency: await this.airportsRepo.getCurrency(code, origin) })
    }

    const missing = resolved.filter((r) => !r.currency)
    if (missing.length > 0) {
      throw new BadRequestError(
        `Sem moeda cadastrada para a origem ${origin} em: ${missing.map((m) => m.airline).join(', ')}`,
      )
    }

    const currencies = [...new Set(resolved.map((r) => r.currency as string))]
    if (currencies.length > 1) {
      throw new BadRequestError(
        `As companhias usam moedas diferentes na origem ${origin} (${resolved.map((r) => `${r.airline}=${r.currency}`).join(', ')})`,
      )
    }
    return currencies[0]
  }

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

    for (const code of data.airlines) {
      const airline = await this.airlinesRepo.findByCode(code)
      if (!airline || !airline.active) throw new BadRequestError(`Companhia '${code}' não disponível`)
    }

    const currency = await this.resolveCurrencyByOrigin(data.airlines, data.origin)

    const today = new Date().toISOString().slice(0, 10)
    if (data.outboundEnd < today) {
      throw new BadRequestError('A data de ida já passou')
    }
    if (data.outboundStart > data.outboundEnd) {
      throw new BadRequestError('outboundStart deve ser anterior a outboundEnd')
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

    const changingAirlines = !!fields.airlines && fields.airlines.length > 0
    if (changingAirlines || fields.origin != null) {
      const airlines = changingAirlines ? fields.airlines! : existing.airlines
      const origin = fields.origin ?? existing.origin
      if (changingAirlines) {
        for (const code of airlines) {
          const airline = await this.airlinesRepo.findByCode(code)
          if (!airline || !airline.active) throw new BadRequestError(`Companhia '${code}' não disponível`)
        }
      }
      fields = { ...fields, currency: await this.resolveCurrencyByOrigin(airlines, origin) }
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

    const changingAirlines = !!fields.airlines && fields.airlines.length > 0
    if (changingAirlines || fields.origin != null) {
      const airlines = changingAirlines ? fields.airlines! : existing.airlines
      const origin = fields.origin ?? existing.origin
      if (changingAirlines) {
        for (const code of airlines) {
          const airline = await this.airlinesRepo.findByCode(code)
          if (!airline || !airline.active) throw new BadRequestError(`Companhia '${code}' não disponível`)
        }
      }
      fields = { ...fields, currency: await this.resolveCurrencyByOrigin(airlines, origin) }
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

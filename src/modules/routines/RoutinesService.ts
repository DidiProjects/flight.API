import { RoutineRow } from '../../types'
import { IRoutinesService } from './interfaces/IRoutinesService'
import { IRoutinesRepository, CreateRoutineData } from './interfaces/IRoutinesRepository'
import { IAirlinesRepository } from '../airlines/interfaces/IAirlinesRepository'
import { IAirportsRepository } from '../airports/interfaces/IAirportsRepository'
import { IFlightFaresRepository } from '../flight-fares/interfaces/IFlightFaresRepository'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors'

const MAX_ROUTINES = 10

export class RoutinesService implements IRoutinesService {
  constructor(
    private readonly routinesRepo: IRoutinesRepository,
    private readonly airlinesRepo: IAirlinesRepository,
    private readonly airportsRepo: IAirportsRepository,
    private readonly flightFaresRepo: IFlightFaresRepository,
  ) {}

  /**
   * Moeda da rotina, resolvida na ordem:
   *   1. moeda fixa da companhia (airlines.currency), quando definida — prioridade máxima;
   *   2. moeda já observada em tarifas coletadas para o trajeto/companhias;
   *   3. moeda do aeroporto de ORIGEM (resolução pelo trajeto);
   *   4. indefinida (null) — quando nada está disponível ainda, a UI não exibe moeda.
   * Não há bloqueio por companhias com moedas diferentes.
   */
  private async resolveCurrency(
    airlines: string[],
    origin: string,
    destination: string,
  ): Promise<string | null> {
    for (const code of airlines) {
      const airline = await this.airlinesRepo.findByCode(code)
      if (airline?.currency) return airline.currency
    }

    const known = await this.flightFaresRepo.getKnownCurrency(airlines, origin, destination)
    if (known) return known

    for (const code of airlines) {
      const fromOrigin = await this.airportsRepo.getCurrency(code, origin)
      if (fromOrigin) return fromOrigin
    }
    return null
  }

  /**
   * Não permite companhia que não cubra ambos os pontos (origem e destino) do trajeto:
   * sem cobertura não há scraping possível para aquela perna.
   */
  private async assertCoverage(airlines: string[], origin: string, destination: string): Promise<void> {
    for (const code of airlines) {
      const [hasOrigin, hasDest] = await Promise.all([
        this.airportsRepo.hasAirport(code, origin),
        this.airportsRepo.hasAirport(code, destination),
      ])
      if (!hasOrigin || !hasDest) {
        const missing = [!hasOrigin ? origin : null, !hasDest ? destination : null].filter(Boolean).join(', ')
        throw new BadRequestError(
          `Companhia '${code}' não cobre ${missing} no trajeto ${origin}→${destination}`,
        )
      }
    }
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
      // Sem busca RT a companhia devolveria as duas pernas avulsas e sem
      // bundle — o desconto de ida-e-volta ficaria invisível e a rotina mentiria.
      if (data.tripType === 'round_trip' && !airline.has_roundtrip) {
        throw new BadRequestError(`Companhia '${code}' não suporta busca de ida e volta`)
      }
    }

    await this.assertCoverage(data.airlines, data.origin, data.destination)

    const currency = await this.resolveCurrency(data.airlines, data.origin, data.destination)

    const today = new Date().toISOString().slice(0, 10)
    if (data.outboundEnd < today) {
      throw new BadRequestError('A data de ida já passou')
    }
    if (data.outboundStart > data.outboundEnd) {
      throw new BadRequestError('outboundStart deve ser anterior a outboundEnd')
    }
    if (data.tripType === 'round_trip') {
      if (data.inboundEnd! < today) {
        throw new BadRequestError('A data de volta já passou')
      }
      if (data.inboundStart! > data.inboundEnd!) {
        throw new BadRequestError('inboundStart deve ser anterior a inboundEnd')
      }
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
    if (changingAirlines || fields.origin != null || fields.destination != null) {
      const airlines = changingAirlines ? fields.airlines! : existing.airlines
      const origin = fields.origin ?? existing.origin
      const destination = fields.destination ?? existing.destination
      if (changingAirlines) {
        for (const code of airlines) {
          const airline = await this.airlinesRepo.findByCode(code)
          if (!airline || !airline.active) throw new BadRequestError(`Companhia '${code}' não disponível`)
        }
      }
      await this.assertCoverage(airlines, origin, destination)
      fields = { ...fields, currency: await this.resolveCurrency(airlines, origin, destination) }
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
    if (changingAirlines || fields.origin != null || fields.destination != null) {
      const airlines = changingAirlines ? fields.airlines! : existing.airlines
      const origin = fields.origin ?? existing.origin
      const destination = fields.destination ?? existing.destination
      if (changingAirlines) {
        for (const code of airlines) {
          const airline = await this.airlinesRepo.findByCode(code)
          if (!airline || !airline.active) throw new BadRequestError(`Companhia '${code}' não disponível`)
        }
      }
      await this.assertCoverage(airlines, origin, destination)
      fields = { ...fields, currency: await this.resolveCurrency(airlines, origin, destination) }
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

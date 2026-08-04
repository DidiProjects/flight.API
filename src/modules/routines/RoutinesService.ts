import { RoutineRow } from '../../types'
import { IRoutinesService } from './interfaces/IRoutinesService'
import { IRoutinesRepository, CreateRoutineData } from './interfaces/IRoutinesRepository'
import { IAirlinesRepository } from '../airlines/interfaces/IAirlinesRepository'
import { IAirportsRepository } from '../airports/interfaces/IAirportsRepository'
import { IFlightFaresRepository } from '../flight-fares/interfaces/IFlightFaresRepository'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors'
import { roundTripPricingError } from '../../utils/roundtrip'
import { airlineCapabilityError, AirlineCapabilities, RoutinePricingState } from '../../utils/airline-capabilities'

const MAX_ROUTINES = 10

/**
 * Como a rotina FICA depois da edição.
 *
 * O corpo do update é parcial e vem em camelCase; a rotina no banco é completa e
 * vem em snake_case. Validar só o que veio no corpo é o furo que deixou passar
 * "troca a companhia e mantém o alvo híbrido".
 *
 * ⚠ `??` não serve aqui: num update parcial, campo AUSENTE é `undefined` e campo
 * LIMPO é `null`, e `??` trata os dois igual. Com ele, trocar a companhia e zerar
 * o alvo híbrido na MESMA chamada era recusado — a validação continuava vendo o
 * alvo antigo que o request estava justamente apagando.
 */
function pick<T>(field: T | undefined, current: T): T {
  return field === undefined ? current : field
}

function finalPricingState(
  existing: RoutineRow,
  fields: Partial<Omit<CreateRoutineData, 'userId'>>,
): RoutinePricingState {
  return {
    tripType:      pick(fields.tripType,      existing.trip_type),
    priority:      pick(fields.priority,      existing.priority),
    targetCash:    pick(fields.targetCash,    existing.target_cash),
    targetPts:     pick(fields.targetPts,     existing.target_pts),
    targetHybPts:  pick(fields.targetHybPts,  existing.target_hyb_pts),
    targetHybCash: pick(fields.targetHybCash, existing.target_hyb_cash),
  }
}

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

  /**
   * Carrega as companhias e verifica se elas atendem ao estado FINAL da rotina.
   *
   * Sobre o estado final, e não sobre o que veio no corpo do request: numa
   * edição parcial, trocar só a companhia mantém prioridade e alvos antigos, e é
   * exatamente aí que a incompatibilidade nascia sem ninguém perguntar nada.
   */
  private async assertCapabilities(codes: string[], routine: RoutinePricingState): Promise<void> {
    const caps: AirlineCapabilities[] = []
    for (const code of codes) {
      const airline = await this.airlinesRepo.findByCode(code)
      if (!airline || !airline.active) throw new BadRequestError(`Companhia '${code}' não disponível`)
      caps.push(airline)
    }
    const err = airlineCapabilityError(caps, routine)
    if (err) throw new BadRequestError(err)
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

    // Sem busca RT a companhia devolveria as duas pernas avulsas e sem bundle — o
    // desconto de ida-e-volta ficaria invisível e a rotina mentiria. E alvo numa
    // dimensão que nenhuma companhia precifica nunca seria avaliado.
    await this.assertCapabilities(data.airlines, {
      tripType:      data.tripType,
      priority:      data.priority,
      targetCash:    data.targetCash,
      targetPts:     data.targetPts,
      targetHybPts:  data.targetHybPts,
      targetHybCash: data.targetHybCash,
    })

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

    // O schema de update é parcial e não enxerga a rotina atual: trocar só a
    // prioridade para 'pts' numa rotina que já é round_trip passaria por ele.
    // A regra vale sobre o estado FINAL, então é aqui que ela cabe.
    const final = finalPricingState(existing, fields)
    if (final.tripType === 'round_trip') {
      const pricingError = roundTripPricingError(final)
      if (pricingError) throw new BadRequestError(pricingError)
    }

    const changingAirlines = !!fields.airlines && fields.airlines.length > 0
    const airlines = changingAirlines ? fields.airlines! : existing.airlines

    // Sempre, não só quando a companhia muda: mexer na prioridade ou num alvo
    // também pode deixar a rotina pedindo o que a companhia atual não precifica.
    await this.assertCapabilities(airlines, final)

    if (changingAirlines || fields.origin != null || fields.destination != null) {
      const origin = fields.origin ?? existing.origin
      const destination = fields.destination ?? existing.destination
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

    // Admin edita a rotina de outra pessoa, não as regras do produto: as mesmas
    // validações do `update` valem aqui. Faltavam as duas — a de preço do
    // round-trip e a de capacidade da companhia.
    const final = finalPricingState(existing, fields)
    if (final.tripType === 'round_trip') {
      const pricingError = roundTripPricingError(final)
      if (pricingError) throw new BadRequestError(pricingError)
    }

    const changingAirlines = !!fields.airlines && fields.airlines.length > 0
    const airlines = changingAirlines ? fields.airlines! : existing.airlines

    await this.assertCapabilities(airlines, final)

    if (changingAirlines || fields.origin != null || fields.destination != null) {
      const origin = fields.origin ?? existing.origin
      const destination = fields.destination ?? existing.destination
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

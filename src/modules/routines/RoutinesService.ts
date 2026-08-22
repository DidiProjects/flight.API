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
 * How the routine LOOKS after the edit.
 *
 * The update body is partial and comes in camelCase; the routine in the bank is
 * complete and comes in snake_case. Validating only what arrived in the body is
 * the hole that let "swap the airline and keep the hybrid target" through.
 *
 * ⚠ `??` does not work here: on a partial update an ABSENT field is `undefined`
 * and a CLEARED one is `null`, and `??` treats both alike. With it, swapping the
 * airline and clearing the hybrid target in the SAME call was refused — the
 * validation still saw the old target the request was erasing.
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
   * Currency of the routine: ALWAYS Real.
   *
   * It used to be deduced from registration (airlines.currency → fares already
   * collected → airports.currency), and the registration is wrong: BA has GBP on
   * all 1192 airports, the 46 in Brazil included. A GRU→LHR routine ended up
   * marked in pounds while receiving fares in Real.
   *
   * The target is now always in Real and the COLLECTION currency comes from
   * scraping, per fare. This field is only the target unit — fixed, and no longer
   * a guess about the market.
   */
  private readonly targetCurrency = 'BRL'

  /**
   * Rejects an airline that does not cover both ends (origin and destination) of
   * the trip: with no coverage there is no scraping possible for that leg.
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
   * Loads the airlines and checks them against the FINAL state of the routine.
   *
   * Against the final state, not against what came in the request body: on a
   * partial edit, swapping only the airline keeps the old priority and targets,
   * and that is exactly where the incompatibility was born unquestioned.
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

    // Without an RT search the airline would return both legs loose and with no
    // bundle — the round-trip discount would be invisible and the routine would
    // lie. And a target in a dimension no airline prices is never evaluated.
    await this.assertCapabilities(data.airlines, {
      tripType:      data.tripType,
      priority:      data.priority,
      targetCash:    data.targetCash,
      targetPts:     data.targetPts,
      targetHybPts:  data.targetHybPts,
      targetHybCash: data.targetHybCash,
    })

    await this.assertCoverage(data.airlines, data.origin, data.destination)

    const currency = this.targetCurrency

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

    // The update schema is partial and does not see the current routine: switching
    // only the priority to 'pts' on a routine that is already round_trip would pass
    // it. The rule applies to the FINAL state, so this is where it fits.
    const final = finalPricingState(existing, fields)
    if (final.tripType === 'round_trip') {
      const pricingError = roundTripPricingError(final)
      if (pricingError) throw new BadRequestError(pricingError)
    }

    const changingAirlines = !!fields.airlines && fields.airlines.length > 0
    const airlines = changingAirlines ? fields.airlines! : existing.airlines

    // Always, not only when the airline changes: touching the priority or a target
    // can also leave the routine asking for what the current airline does not price.
    await this.assertCapabilities(airlines, final)

    if (changingAirlines || fields.origin != null || fields.destination != null) {
      const origin = fields.origin ?? existing.origin
      const destination = fields.destination ?? existing.destination
      await this.assertCoverage(airlines, origin, destination)
      fields = { ...fields, currency: this.targetCurrency }
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

    // Admin edits another person's routine, not the product rules: the same
    // validations as `update` apply here. Both were missing — the round-trip price
    // one and the airline capability one.
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
      fields = { ...fields, currency: this.targetCurrency }
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

import { BestFareRow, RoutineRow } from '../../types'
import { IBestFaresService, UserBestFaresResult, FareResult } from './interfaces/IBestFaresService'
import { IBestFaresRepository } from './interfaces/IBestFaresRepository'
import { IRoutinesRepository } from '../routines/interfaces/IRoutinesRepository'

export class BestFaresService implements IBestFaresService {
  constructor(
    private readonly bestFaresRepo: IBestFaresRepository,
    private readonly routinesRepo: IRoutinesRepository,
  ) {}

  async adminGetUserBestFares(userId: string): Promise<UserBestFaresResult[]> {
    const routines = await this.routinesRepo.findByUser(userId)
    return Promise.all(routines.map((r) => this.buildResult(r)))
  }

  private async buildResult(routine: RoutineRow): Promise<UserBestFaresResult> {
    const [outbound, ret] = await Promise.all([
      this.bestFaresRepo.getBest(routine.id, false, routine.priority),
      routine.return_start
        ? this.bestFaresRepo.getBest(routine.id, true, routine.priority)
        : Promise.resolve(null),
    ])
    return {
      routineId:   routine.id,
      routineName: routine.name,
      origin:      routine.origin,
      destination: routine.destination,
      priority:    routine.priority,
      isActive:    routine.is_active,
      outbound:    outbound ? this.formatFare(outbound) : null,
      return:      ret      ? this.formatFare(ret)      : null,
    }
  }

  private formatFare(bf: BestFareRow): FareResult {
    return {
      amount:     bf.amount,
      currency:   bf.currency,
      date:       bf.date,
      updatedAt:  bf.updated_at,
      analysisId: bf.analysis_id,
      offer: {
        flightNumber:  bf.offer.flight_number,
        departureTime: bf.offer.origin_timestamp,
        arrivalTime:   bf.offer.destination_timestamp,
        durationMin:   bf.offer.duration_min,
        stops:         bf.offer.stops,
      },
    }
  }
}

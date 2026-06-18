import { IEvaluationService } from './interfaces/IEvaluationService'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { IFlightFaresRepository, LatestFaresByDate, PriceHistory } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import { INotificationsService } from '../notifications/interfaces/INotificationsService'
import { RoutineRow } from '../../types'
import { logger } from '../../utils/logger'

const log = logger.child({ service: 'evaluation' })

function toDateStr(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
}

export { toDateStr }

export class EvaluationService implements IEvaluationService {
  constructor(
    private readonly routinesRepo: IRoutinesRepository,
    private readonly flightFaresRepo: IFlightFaresRepository,
    private readonly notifSvc: INotificationsService,
  ) {}

  async runCycle(): Promise<void> {
    let routines: RoutineRow[]
    try {
      routines = await this.routinesRepo.findAllActive()
    } catch (err) {
      log.error({ err }, 'evaluation cycle: failed to fetch active routines')
      return
    }

    for (const routine of routines) {
      try {
        await this.evaluateRoutine(routine)
      } catch (err) {
        log.error({ err, routineId: routine.id }, 'evaluation cycle error')
      }
    }
  }

  private async evaluateRoutine(routine: RoutineRow): Promise<void> {
    const allOutbound: LatestFaresByDate[] = []
    const allReturn: LatestFaresByDate[] = []

    for (const airline of routine.airlines) {
      const outbound = await this.flightFaresRepo.getLatestByRoute(
        airline,
        routine.origin,
        routine.destination,
        toDateStr(routine.outbound_start),
        toDateStr(routine.outbound_end),
      )
      allOutbound.push(...outbound)

      if (routine.return_start && routine.return_end) {
        const ret = await this.flightFaresRepo.getLatestByRoute(
          airline,
          routine.destination,
          routine.origin,
          toDateStr(routine.return_start),
          toDateStr(routine.return_end),
        )
        allReturn.push(...ret)
      }
    }

    if (allOutbound.length === 0) return

    const bestMatch = this.findBestMatch(allOutbound, routine)
    if (!bestMatch) return

    const recentAlert = await this.notifSvc.hasRecentAlert(routine.id, 24)
    if (recentAlert) return

    const history = await this.flightFaresRepo.getPriceHistory(
      bestMatch.airline,
      routine.origin,
      routine.destination,
      toDateStr(bestMatch.flight_date),
    )

    const bestReturn = allReturn.length > 0 ? this.bestFare(allReturn, routine) : null

    await this.notifSvc.dispatchAlert(routine, bestMatch, bestReturn, history)
  }

  private findBestMatch(fares: LatestFaresByDate[], routine: RoutineRow): LatestFaresByDate | null {
    const t = 1 + routine.margin

    const candidates = fares.filter((f) => {
      if (routine.priority === 'cash' && routine.target_cash != null && f.fare_cash != null)
        return f.fare_cash <= routine.target_cash * t
      if (routine.priority === 'pts' && routine.target_pts != null && f.fare_pts != null)
        return f.fare_pts <= routine.target_pts * t
      if (
        routine.priority === 'hyb' &&
        routine.target_hyb_pts != null && routine.target_hyb_cash != null &&
        f.fare_hyb_pts != null && f.fare_hyb_cash != null
      )
        return f.fare_hyb_pts <= routine.target_hyb_pts * t && f.fare_hyb_cash <= routine.target_hyb_cash * t
      return false
    })

    if (candidates.length === 0) return null

    return this.bestFare(candidates, routine)
  }

  private bestFare(fares: LatestFaresByDate[], routine: RoutineRow): LatestFaresByDate | null {
    const withValue = fares.filter((f) => this.fareValue(f, routine) !== null)
    if (withValue.length === 0) return null
    return withValue.reduce((best, curr) => {
      const bestVal = this.fareValue(best, routine)!
      const currVal = this.fareValue(curr, routine)!
      return currVal < bestVal ? curr : best
    })
  }

  private fareValue(fare: LatestFaresByDate, routine: RoutineRow): number | null {
    // NUMERIC volta do pg como string — coagir para Number, senão a comparação
    // do bestFare vira lexicográfica ("1076.00" < "652.00" === true).
    const raw =
      routine.priority === 'cash' ? fare.fare_cash :
      routine.priority === 'pts'  ? fare.fare_pts :
      routine.priority === 'hyb'  ? fare.fare_hyb_pts :
      null
    return raw == null ? null : Number(raw)
  }
}

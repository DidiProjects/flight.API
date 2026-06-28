import { IEvaluationService } from './interfaces/IEvaluationService'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { IFlightFaresRepository, LatestFaresByDate, PriceHistory } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import { INotificationsService } from '../notifications/interfaces/INotificationsService'
import { RoutineRow } from '../../types'
import { logger } from '../../utils/logger'

const log = logger.child({ service: 'evaluation' })

// Tarifas mais velhas que isso são consideradas obsoletas e não geram alerta.
// Bem acima do maior intervalo de re-scraping (12h) para não suprimir alertas legítimos.
const MAX_FARE_AGE_HOURS = 48

function toDateStr(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
}

// Janela do anti-spam do alerta target, derivada da frequência da rotina.
function frequencyToHours(freq: string): number {
  switch (freq) {
    case 'hourly':  return 1
    case 'monthly': return 24 * 30
    case 'daily':
    default:        return 24
  }
}

export { toDateStr, frequencyToHours }

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
    // Só alerta quem optou pelo modo 'target'.
    if (!routine.notification_modes.includes('target')) return

    const allOutbound: LatestFaresByDate[] = []

    for (const airline of routine.airlines) {
      const outbound = await this.flightFaresRepo.getLatestByRoute(
        airline,
        routine.origin,
        routine.destination,
        toDateStr(routine.outbound_start),
        toDateStr(routine.outbound_end),
        MAX_FARE_AGE_HOURS,
      )
      allOutbound.push(...outbound)
    }

    if (allOutbound.length === 0) return

    const bestMatch = this.findBestMatch(allOutbound, routine)
    if (!bestMatch) return

    const recentAlert = await this.notifSvc.hasRecentAlert(routine.id, frequencyToHours(routine.notification_frequency))
    if (recentAlert) return

    const history = await this.flightFaresRepo.getPriceHistory(
      bestMatch.airline,
      routine.origin,
      routine.destination,
      toDateStr(bestMatch.flight_date),
    )

    await this.notifSvc.dispatchAlert(routine, bestMatch, null, history)
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

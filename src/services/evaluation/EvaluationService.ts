import { IEvaluationService } from './interfaces/IEvaluationService'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { IFlightFaresRepository, LatestFaresByDate } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import { ITargetAlertStateRepository } from '../../modules/target-alert-state/interfaces/ITargetAlertStateRepository'
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

export { toDateStr }

export class EvaluationService implements IEvaluationService {
  constructor(
    private readonly routinesRepo: IRoutinesRepository,
    private readonly flightFaresRepo: IFlightFaresRepository,
    private readonly alertStateRepo: ITargetAlertStateRepository,
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

  async cleanupAlertState(): Promise<number> {
    return this.alertStateRepo.cleanupPastDates()
  }

  private async evaluateRoutine(routine: RoutineRow): Promise<void> {
    // Só alerta quem optou pelo modo 'target'.
    if (!routine.notification_modes.includes('target')) return

    // 1. Última foto fresca de tarifas de todas as companhias no grid de datas.
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

    // 2. Melhor tarifa DENTRO do alvo por data do grid (entre todas as companhias).
    const bestByDate = this.bestInTargetByDate(allOutbound, routine)
    if (bestByDate.size === 0) return

    // 3. Comparar cada data com seu watermark (melhor preço já alertado para ela).
    const fareType = routine.priority
    const watermarks = await this.alertStateRepo.getWatermarks(routine.id, fareType)

    // Piso de preço da rotina: o menor valor já alertado em QUALQUER data. Datas
    // novas que entram no alvo com preço igual/pior que esse piso seguem sendo
    // gravadas (watermark por data intacto), mas NÃO disparam e-mail — só
    // notificamos quando a rotina bate um novo recorde de preço.
    const routineFloor = watermarks.size ? Math.min(...watermarks.values()) : Infinity

    const candidates: { flightDate: string; amount: number; fare: LatestFaresByDate }[] = []
    for (const [date, fare] of bestByDate) {
      const amount = this.fareValue(fare, routine)!
      const prev = watermarks.get(date)
      // Primeira oferta no alvo para a data, ou preço melhor (menor) que o já alertado.
      if (prev == null || amount < prev) candidates.push({ flightDate: date, amount, fare })
    }
    if (candidates.length === 0) return

    // 4. Upsert monotônico atômico → só as datas que o banco confirmou como avançadas
    //    (à prova de corrida entre ciclos sobrepostos, sem cooldown por tempo).
    const advanced = await this.alertStateRepo.recordNotified(
      routine.id,
      fareType,
      candidates.map((c) => ({ flightDate: c.flightDate, amount: c.amount, airline: c.fare.airline })),
    )
    if (advanced.size === 0) return

    // 5. Ofertas das datas que avançaram, da mais barata para a mais cara.
    const offers = candidates
      .filter((c) => advanced.has(c.flightDate))
      .sort((a, b) => a.amount - b.amount)
    if (offers.length === 0) return

    // 6. Gate de recorde por rotina. As datas que avançaram já foram gravadas no
    //    watermark por data (passo 4, histórico intacto), mas só mandamos e-mail
    //    se a oferta mais barata bater o piso da rotina. Assim datas novas no
    //    mesmo preço deixam de empilhar um e-mail por ciclo.
    const headline = offers[0]
    if (headline.amount >= routineFloor) {
      log.info({
        routineId:      routine.id,
        routineName:    routine.name,
        headlineAmount: headline.amount,
        routineFloor,
        advancedDates:  offers.map((o) => o.flightDate),
        type:           'alert',
        status:         'suppressed-not-record',
      }, 'evaluation: datas avançaram o watermark mas não bateram o recorde da rotina — e-mail suprimido')
      return
    }

    // 7. Histórico (% abaixo da média 30d) para a oferta-headline (a mais barata).
    const history = await this.flightFaresRepo.getPriceHistory(
      headline.fare.airline,
      routine.origin,
      routine.destination,
      headline.flightDate,
    )

    await this.notifSvc.dispatchAlert(routine, offers.map((o) => o.fare), history)
  }

  // Melhor tarifa dentro do alvo por data (colapsa companhias: o usuário quer o
  // melhor preço da data, a companhia é só detalhe exibido no e-mail).
  private bestInTargetByDate(fares: LatestFaresByDate[], routine: RoutineRow): Map<string, LatestFaresByDate> {
    const best = new Map<string, LatestFaresByDate>()
    for (const f of fares) {
      if (!this.inTarget(f, routine)) continue
      const v = this.fareValue(f, routine)
      if (v == null) continue
      const date = toDateStr(f.flight_date)
      const cur = best.get(date)
      if (cur == null || v < this.fareValue(cur, routine)!) best.set(date, f)
    }
    return best
  }

  private inTarget(f: LatestFaresByDate, routine: RoutineRow): boolean {
    const t = 1 + routine.margin
    if (routine.priority === 'cash' && routine.target_cash != null && f.fare_cash != null)
      return Number(f.fare_cash) <= routine.target_cash * t
    if (routine.priority === 'pts' && routine.target_pts != null && f.fare_pts != null)
      return Number(f.fare_pts) <= routine.target_pts * t
    if (
      routine.priority === 'hyb' &&
      routine.target_hyb_pts != null && routine.target_hyb_cash != null &&
      f.fare_hyb_pts != null && f.fare_hyb_cash != null
    )
      return Number(f.fare_hyb_pts) <= routine.target_hyb_pts * t && Number(f.fare_hyb_cash) <= routine.target_hyb_cash * t
    return false
  }

  private fareValue(fare: LatestFaresByDate, routine: RoutineRow): number | null {
    // NUMERIC volta do pg como string — coagir para Number, senão a comparação
    // vira lexicográfica ("1076.00" < "652.00" === true).
    const raw =
      routine.priority === 'cash' ? fare.fare_cash :
      routine.priority === 'pts'  ? fare.fare_pts :
      routine.priority === 'hyb'  ? fare.fare_hyb_pts :
      null
    return raw == null ? null : Number(raw)
  }
}

import { IEvaluationService } from './interfaces/IEvaluationService'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { IFlightFaresRepository, LatestFaresByDate, PairFareRow } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import { ITargetAlertStateRepository } from '../../modules/target-alert-state/interfaces/ITargetAlertStateRepository'
import { INotificationsService } from '../notifications/interfaces/INotificationsService'
import { RoutineRow } from '../../types'
import { logger } from '../../utils/logger'
import { isValidRoundTripPair } from '../../utils/roundtrip'
import { IncompleteRoundTripError } from '../../utils/errors'

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

    // 1-2. Melhor oferta dentro do alvo por data de ida. Em round_trip a oferta
    //      da data é o PAR (ida + volta) e o alvo é comparado contra o total.
    let inboundByDate: Map<string, LatestFaresByDate> | undefined
    let bestByDate: Map<string, LatestFaresByDate>
    // Valor que a data vale para o alerta: a perna (one-way) ou o total do par (RT).
    let amountByDate: Map<string, number>

    if (routine.trip_type === 'round_trip') {
      const pairs = await this.bestPairsByOutboundDate(routine)
      if (pairs.size === 0) return
      bestByDate    = new Map([...pairs].map(([date, p]) => [date, p.outbound]))
      inboundByDate = new Map([...pairs].map(([date, p]) => [date, p.inbound]))
      amountByDate  = new Map([...pairs].map(([date, p]) => [date, p.total]))
    } else {
      const allOutbound: LatestFaresByDate[] = []
      for (const airline of routine.airlines) {
        const outbound = await this.flightFaresRepo.getLatestByRoute(
          airline,
          routine.origin,
          routine.destination,
          toDateStr(routine.outbound_start),
          toDateStr(routine.outbound_end),
          // Rotina one-way só enxerga tarifa avulsa. Tarifa colhida numa busca
          // ida-e-volta é preço de par e não vale como one-way.
          null,
          MAX_FARE_AGE_HOURS,
        )
        allOutbound.push(...outbound)
      }
      if (allOutbound.length === 0) return

      bestByDate   = this.bestInTargetByDate(allOutbound, routine)
      amountByDate = new Map([...bestByDate].map(([date, f]) => [date, this.fareValue(f, routine)!]))
    }
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
      const amount = amountByDate.get(date)!
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

    // One-way chama com a assinatura original (sem o 4º argumento) para não
    // mudar nada no caminho que já existia.
    const fares = offers.map((o) => o.fare)
    if (inboundByDate) await this.notifSvc.dispatchAlert(routine, fares, history, inboundByDate)
    else await this.notifSvc.dispatchAlert(routine, fares, history)
  }

  /**
   * Melhor par (ida, volta) por data de ida, para rotinas round_trip.
   *
   * Decisões de produto (2026-07-24):
   *  · as duas pernas na MESMA companhia — só assim o desconto RT é identificável;
   *  · par só vale com a MESMA moeda nas duas pernas — sem conversão de câmbio;
   *  · volta no máximo 3 meses depois da ida (`isValidRoundTripPair`);
   *  · companhia que voltou com só uma das pernas é descartada e reportada.
   *
   * A célula do watermark continua sendo a data de IDA: cada data de ida carrega
   * o melhor total válido que ela consegue fechar. Assim o alerta segue com uma
   * linha por data e o `routineFloor` continua valendo sem mudança de schema.
   */
  private async bestPairsByOutboundDate(
    routine: RoutineRow,
  ): Promise<Map<string, { outbound: LatestFaresByDate; inbound: LatestFaresByDate; total: number }>> {
    const best = new Map<string, { outbound: LatestFaresByDate; inbound: LatestFaresByDate; total: number }>()

    for (const airline of routine.airlines) {
      const rows = await this.flightFaresRepo.getLatestPairs(
        airline, routine.origin, routine.destination,
        toDateStr(routine.outbound_start), toDateStr(routine.outbound_end),
        toDateStr(routine.inbound_start!), toDateStr(routine.inbound_end!),
        MAX_FARE_AGE_HOURS,
      )
      if (rows.length === 0) continue

      // Agrupa pela EXECUÇÃO: as duas pernas do par saem da mesma busca RT e
      // compartilham request_id. Agrupar por flight_date separava as pernas em
      // grupos diferentes (a volta carrega a data DELA) e todo par real caía
      // como incompleto.
      const byPair = new Map<string, PairFareRow[]>()
      for (const r of rows) {
        const list = byPair.get(r.request_id)
        if (list) list.push(r)
        else byPair.set(r.request_id, [r])
      }

      for (const legs of byPair.values()) {
        const outDate = toDateStr(legs[0].pair_outbound_date)
        // Só para log: identifica o par nas mensagens de par incompleto.
        const key = `${outDate}|${toDateStr(legs[0].return_date)}`
        const outbound = legs.filter((l) => !l.is_return)
        const inbound = legs.filter((l) => l.is_return)

        // Volta indefinida por limitação conhecida: a volta EXISTE, a companhia
        // só não deixa vê-la (em pontos a Azul exige login do TudoAzul). Não é
        // dado corrompido, então não reporta — mas também não vira total: se a
        // volta é desconhecida, o preço da ida não é o preço da viagem.
        if (inbound.length === 0 && outbound.length > 0 && outbound.every((o) => o.inbound_unavailable)) {
          log.info(
            { routineId: routine.id, airline, pair: key },
            'evaluation: volta indefinida (limitação conhecida) — par exibido sem total, sem alerta',
          )
          continue
        }

        // Par que voltou com uma perna só é dado corrompido, não oferta barata.
        if (outbound.length === 0 || inbound.length === 0) {
          const missingLeg = outbound.length === 0 ? 'outbound' : 'inbound'
          log.error(
            { err: new IncompleteRoundTripError(routine.id, airline, missingLeg), routineId: routine.id, airline, missingLeg, pair: key },
            'evaluation: par round-trip incompleto — par descartado do ciclo',
          )
          continue
        }

        // Moedas diferentes entre as pernas: sem conversão de câmbio, não avalia.
        if ((outbound[0].currency ?? null) !== (inbound[0].currency ?? null)) continue

        for (const out of outbound) {
          const outValue = this.fareValue(out, routine)
          if (outValue == null) continue

          // As voltas desta ida — e só elas. Uma volta foi precificada NO
          // CONTEXTO de uma ida: cruzar com outra inventaria um par que a
          // companhia nunca ofereceu (e é justamente onde o desconto vive).
          const mine = this.inboundsFor(out, inbound)
          if (mine.length === 0) {
            // O par tem voltas, mas nenhuma é desta ida. Se a limitação é
            // conhecida, tolera em silêncio; senão é dado corrompido.
            if (out.inbound_unavailable) {
              log.info(
                { routineId: routine.id, airline, pair: key, outboundFlight: out.flight_number },
                'evaluation: ida com volta indefinida — sem total, sem alerta',
              )
            } else {
              log.error(
                { err: new IncompleteRoundTripError(routine.id, airline, 'inbound'), routineId: routine.id, airline, pair: key, outboundFlight: out.flight_number },
                'evaluation: ida sem nenhuma volta vinculada — ida descartada do ciclo',
              )
            }
            continue
          }

          for (const inb of mine) {
            const inValue = this.fareValue(inb, routine)
            if (inValue == null) continue

            // Preço do par: o bundle da cia quando veio, senão a soma das pernas
            // daquela mesma busca RT. Nunca mistura com tarifa avulsa.
            const bundle = this.bundleValue(out, routine)
            const total = bundle ?? outValue + inValue
            if (!this.totalInTarget(total, routine, out, inb)) continue

            const cur = best.get(outDate)
            if (cur == null || total < cur.total) best.set(outDate, { outbound: out, inbound: inb, total })
          }
        }
      }
    }

    return best
  }

  /**
   * Voltas que pertencem a esta ida.
   *
   * O scraper carimba `paired_outbound_flight` em cada volta com o número do voo
   * de ida que a precificou. Coleta anterior a esse carimbo não tem o vínculo:
   * nesse caso cai no comportamento antigo (todas as voltas do par), senão as
   * tarifas já no banco parariam de ser avaliadas da noite para o dia.
   */
  private inboundsFor(out: PairFareRow, inbound: PairFareRow[]): PairFareRow[] {
    const linked = inbound.filter((i) => i.paired_outbound_flight != null)
    if (linked.length === 0) return inbound
    return linked.filter((i) => i.paired_outbound_flight === out.flight_number)
  }

  /** Total do par cobrado pela companhia (bundle), na dimensão de preço da rotina. */
  private bundleValue(fare: PairFareRow, routine: RoutineRow): number | null {
    const raw =
      routine.priority === 'cash' ? fare.bundle_cash :
      routine.priority === 'pts'  ? fare.bundle_pts :
      routine.priority === 'hyb'  ? fare.bundle_hyb_pts :
      null
    return raw == null ? null : Number(raw)
  }

  /**
   * Alvo do par: em round_trip o usuário mira o preço da VIAGEM, então o total
   * das duas pernas é comparado com o target (com a mesma margem do one-way).
   * No modo híbrido as duas dimensões precisam caber somadas.
   */
  private totalInTarget(
    total: number,
    routine: RoutineRow,
    out: LatestFaresByDate,
    inb: LatestFaresByDate,
  ): boolean {
    const t = 1 + routine.margin
    if (routine.priority === 'cash') return routine.target_cash != null && total <= routine.target_cash * t
    if (routine.priority === 'pts')  return routine.target_pts != null && total <= routine.target_pts * t
    if (routine.priority === 'hyb') {
      if (routine.target_hyb_pts == null || routine.target_hyb_cash == null) return false
      if (out.fare_hyb_cash == null || inb.fare_hyb_cash == null) return false
      const cashTotal = Number(out.fare_hyb_cash) + Number(inb.fare_hyb_cash)
      return total <= routine.target_hyb_pts * t && cashTotal <= routine.target_hyb_cash * t
    }
    return false
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

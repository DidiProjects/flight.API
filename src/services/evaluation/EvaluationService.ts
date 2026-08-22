import { IEvaluationService } from './interfaces/IEvaluationService'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { IFlightFaresRepository, LatestFaresByDate, PairFareRow } from '../../modules/flight-fares/interfaces/IFlightFaresRepository'
import {
  ITargetAlertStateRepository,
  PriceBreakdown,
} from '../../modules/target-alert-state/interfaces/ITargetAlertStateRepository'
import { INotificationsService } from '../notifications/interfaces/INotificationsService'
import { IFxRateService } from '../fx/interfaces/IFxRateService'
import { AlertTotal } from '../email/interfaces/IEmailService'
import { RoutineRow } from '../../types'
import { logger } from '../../utils/logger'
import { isValidRoundTripPair } from '../../utils/roundtrip'
import { IncompleteRoundTripError } from '../../utils/errors'

const log = logger.child({ service: 'evaluation' })

// Tarifas mais velhas que isso são consideradas obsoletas e não geram alerta.
// Bem acima do maior intervalo de re-scraping (12h) para não suprimir alertas legítimos.
const MAX_FARE_AGE_HOURS = 48

/** O par vencedor de uma data de ida, com a composição original das duas pernas. */
interface PairChoice {
  outbound: LatestFaresByDate
  inbound: LatestFaresByDate
  total: number
  breakdown: PriceBreakdown[]
  /** Alguma das duas pernas foi convertida, e com que cotação. */
  converted: boolean
  rateDate: string | null
}

/**
 * Uma tarifa pronta para comparar.
 *
 * `value` está na unidade do alvo: BRL em rotina `cash` (convertido quando a
 * companhia cobrou noutra moeda), pontos em `pts` e `hyb`. `breakdown` guarda o
 * que a companhia REALMENTE cobrou, na moeda dela — é o que o watermark usa
 * para saber se o preço mudou ou se foi só o câmbio.
 */
interface Comparable {
  value: number
  /** Só em `hyb`: a parte em dinheiro, já em BRL. */
  hybCashBrl: number | null
  breakdown: PriceBreakdown
  /** Houve conversão? E com que cotação? É o que o e-mail precisa dizer. */
  converted: boolean
  rateDate: string | null
}

/** What steps 1-2 hand to the alert: one entry per outbound date within target. */
interface TargetOffers {
  bestByDate: Map<string, LatestFaresByDate>
  inboundByDate: Map<string, LatestFaresByDate> | undefined
  amountByDate: Map<string, number>
  breakdownByDate: Map<string, PriceBreakdown[]>
  totalsByDate: Map<string, AlertTotal> | undefined
}

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
    private readonly fx: IFxRateService,
    /**
     * Margem que absorve ruído de câmbio quando a composição do preço muda por
     * pouco. A composição idêntica já barra o caso comum (§5.6 do plano); esta
     * é a rede para variação de centavo.
     */
    private readonly fxNoiseMargin = 0.01,
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

  /**
   * Re-sends the routine's target alert with the data that is in the bank right
   * now, skipping steps 3-6 — the whole point of asking for a resend is to
   * repeat what the anti-repetition would suppress.
   *
   * It deliberately does NOT touch target_alert_state: a diagnostic resend that
   * moved the watermark would change which alerts fire later, and the operator
   * asking for a copy of an e-mail is not asking for that.
   */
  async resendAlert(routine: RoutineRow): Promise<boolean> {
    const offers = await this.offersInTarget(routine)
    if (!offers) return false

    const { bestByDate, inboundByDate, amountByDate, totalsByDate } = offers

    // Same ordering as the cycle: cheapest first, ties broken by the most
    // recently scraped fare — so the headline here is the headline there.
    const sorted = [...bestByDate.entries()]
      .map(([flightDate, fare]) => ({ flightDate, fare, amount: amountByDate.get(flightDate)! }))
      .sort((a, b) =>
        a.amount - b.amount ||
        new Date(b.fare.scraped_at).getTime() - new Date(a.fare.scraped_at).getTime(),
      )
    if (sorted.length === 0) return false

    const headline = sorted[0]
    const history = await this.flightFaresRepo.getPriceHistory(
      headline.fare.airline,
      routine.origin,
      routine.destination,
      headline.flightDate,
    )

    const fares = sorted.map((o) => o.fare)
    if (inboundByDate) await this.notifSvc.dispatchAlert(routine, fares, history, inboundByDate, totalsByDate)
    else await this.notifSvc.dispatchAlert(routine, fares, history)

    log.info({
      routineId:   routine.id,
      routineName: routine.name,
      dates:       sorted.map((o) => o.flightDate),
      type:        'alert',
      trigger:     'manual-resend',
      status:      'success',
    }, 'alert resent by admin')

    return true
  }

  /**
   * Steps 1-2 of the cycle: the best offer WITHIN TARGET per outbound date. On a
   * round trip the date's offer is the pair (outbound + inbound) and the target
   * is compared against the total. `null` when nothing is within target.
   *
   * It lives apart because the manual resend needs exactly this and nothing that
   * follows: steps 3-6 are the anti-repetition, and a resend is precisely a
   * request to repeat.
   */
  private async offersInTarget(routine: RoutineRow): Promise<TargetOffers | null> {
    // 1-2. Melhor oferta dentro do alvo por data de ida. Em round_trip a oferta
    //      da data é o PAR (ida + volta) e o alvo é comparado contra o total.
    let inboundByDate: Map<string, LatestFaresByDate> | undefined
    let bestByDate: Map<string, LatestFaresByDate>
    // A composição original do preço de cada data — o que a companhia cobrou,
    // sem conversão. É ela que diz se houve queda ou se foi só o câmbio.
    let breakdownByDate: Map<string, PriceBreakdown[]>
    // Valor que a data vale para o alerta: a perna (one-way) ou o total do par (RT).
    let amountByDate: Map<string, number>
    // Só em round_trip: o total já convertido, para o e-mail não somar moedas.
    let totalsByDate: Map<string, AlertTotal> | undefined

    if (routine.trip_type === 'round_trip') {
      const pairs = await this.bestPairsByOutboundDate(routine)
      if (pairs.size === 0) return null
      bestByDate      = new Map([...pairs].map(([date, p]) => [date, p.outbound]))
      inboundByDate   = new Map([...pairs].map(([date, p]) => [date, p.inbound]))
      amountByDate    = new Map([...pairs].map(([date, p]) => [date, p.total]))
      breakdownByDate = new Map([...pairs].map(([date, p]) => [date, p.breakdown]))
      // O total do par, pronto para o e-mail: quem soma é aqui, depois de
      // converter. Somar as pernas lá na frente somaria libra com euro.
      totalsByDate = new Map([...pairs].map(([date, p]) => [date, {
        amount: p.total,
        currency: routine.priority === 'cash' ? 'BRL' : 'PTS',
        converted: p.converted,
        rateDate: p.rateDate,
      }]))
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
      if (allOutbound.length === 0) return null

      const chosen = await this.bestInTargetByDate(allOutbound, routine)
      bestByDate     = new Map([...chosen].map(([date, c]) => [date, c.fare]))
      amountByDate   = new Map([...chosen].map(([date, c]) => [date, c.cmp.value]))
      breakdownByDate = new Map([...chosen].map(([date, c]) => [date, [c.cmp.breakdown]]))
    }
    if (bestByDate.size === 0) return null


    return { bestByDate, inboundByDate, amountByDate, breakdownByDate, totalsByDate }
  }

  private async evaluateRoutine(routine: RoutineRow): Promise<void> {
    // Só alerta quem optou pelo modo 'target'.
    if (!routine.notification_modes.includes('target')) return

    const offersFound = await this.offersInTarget(routine)
    if (!offersFound) return
    const { bestByDate, inboundByDate, amountByDate, breakdownByDate, totalsByDate } = offersFound

    // 3. Comparar cada data com seu watermark (melhor preço já alertado para ela).
    const fareType = routine.priority
    const watermarks = await this.alertStateRepo.getWatermarks(routine.id, fareType)

    // Piso de preço da rotina: o menor valor já alertado em QUALQUER data. Datas
    // novas que entram no alvo com preço igual/pior que esse piso seguem sendo
    // gravadas (watermark por data intacto), mas NÃO disparam e-mail — só
    // notificamos quando a rotina bate um novo recorde de preço.
    const routineFloor = watermarks.size
      ? Math.min(...[...watermarks.values()].map((w) => w.amount))
      : Infinity

    const candidates: { flightDate: string; amount: number; fare: LatestFaresByDate; breakdown: PriceBreakdown[] }[] = []
    for (const [date, fare] of bestByDate) {
      const amount = amountByDate.get(date)!
      const breakdown = breakdownByDate.get(date)!
      const prev = watermarks.get(date)

      // Primeira oferta no alvo para a data: sempre candidata.
      if (prev == null) {
        candidates.push({ flightDate: date, amount, fare, breakdown })
        continue
      }

      // A companhia cobra exatamente o mesmo, nas mesmas moedas: o que mudou foi
      // a cotação. Não é queda de preço e não pode derrubar o watermark.
      if (this.sameBreakdown(prev.breakdown, breakdown)) continue

      // Composição diferente: compara em Real, com a margem que absorve o
      // centavo de ruído.
      if (amount < prev.amount * (1 - this.fxNoiseMargin)) {
        candidates.push({ flightDate: date, amount, fare, breakdown })
      }
    }
    if (candidates.length === 0) return

    // 4. Upsert monotônico atômico → só as datas que o banco confirmou como avançadas
    //    (à prova de corrida entre ciclos sobrepostos, sem cooldown por tempo).
    const advanced = await this.alertStateRepo.recordNotified(
      routine.id,
      fareType,
      candidates.map((c) => ({
        flightDate: c.flightDate, amount: c.amount, airline: c.fare.airline, breakdown: c.breakdown,
      })),
    )
    if (advanced.size === 0) return

    // 5. Ofertas das datas que avançaram, da mais barata para a mais cara.
    //    Empate de preço → tarifa coletada mais recentemente (scraped_at). Esse é
    //    o MESMO critério que o dispatchAlert usa para escolher a headline, então
    //    offers[0] é provadamente a tarifa que o e-mail renderiza — e o histórico
    //    (passo 7) é calculado para ela, sem divergência entre card e nota.
    const offers = candidates
      .filter((c) => advanced.has(c.flightDate))
      .sort((a, b) =>
        a.amount - b.amount ||
        new Date(b.fare.scraped_at).getTime() - new Date(a.fare.scraped_at).getTime(),
      )
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
    if (inboundByDate) await this.notifSvc.dispatchAlert(routine, fares, history, inboundByDate, totalsByDate)
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
  ): Promise<Map<string, PairChoice>> {
    const best = new Map<string, PairChoice>()

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

        // A guarda de "moedas diferentes entre as pernas" saiu daqui: ela existia
        // porque não havia conversão, e descartava justamente o par legítimo em
        // que a companhia cobra cada perna no mercado dela. Com as duas pernas
        // em Real, a soma passa a valer.

        for (const out of outbound) {
          const outCmp = await this.comparable(out, routine, 'outbound')
          if (outCmp == null) continue
          const outValue = outCmp.value

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
            const inCmp = await this.comparable(inb, routine, 'inbound')
            if (inCmp == null) continue
            const inValue = inCmp.value

            // Preço do par: o bundle da cia quando veio, senão a soma das pernas
            // daquela mesma busca RT. Nunca mistura com tarifa avulsa.
            const bundle = this.bundleValue(out, routine)
            const total = bundle ?? outValue + inValue
            if (!this.totalInTarget(total, routine, outCmp, inCmp)) continue

            const cur = best.get(outDate)
            if (cur == null || total < cur.total) {
              // A composição do PAR: as duas pernas como a companhia cobrou.
              best.set(outDate, {
                outbound: out, inbound: inb, total,
                breakdown: [outCmp.breakdown, inCmp.breakdown],
                converted: outCmp.converted || inCmp.converted,
                rateDate:  outCmp.rateDate ?? inCmp.rateDate,
              })
            }
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
    out: Comparable,
    inb: Comparable,
  ): boolean {
    const t = 1 + routine.margin
    if (routine.priority === 'cash') return routine.target_cash != null && total <= routine.target_cash * t
    if (routine.priority === 'pts')  return routine.target_pts != null && total <= routine.target_pts * t
    if (routine.priority === 'hyb') {
      if (routine.target_hyb_pts == null || routine.target_hyb_cash == null) return false
      // As partes em dinheiro já vêm em Real: somar libra com euro daria número
      // sem significado.
      if (out.hybCashBrl == null || inb.hybCashBrl == null) return false
      const cashTotal = out.hybCashBrl + inb.hybCashBrl
      return total <= routine.target_hyb_pts * t && cashTotal <= routine.target_hyb_cash * t
    }
    return false
  }

  /**
   * Melhor tarifa dentro do alvo por data.
   *
   * Colapsa companhias — o usuário quer o melhor preço da data, a companhia é
   * detalhe do e-mail. E como as companhias de uma mesma rotina podem cobrar em
   * moedas diferentes, o mínimo só faz sentido depois da conversão: comparar
   * £730 com R$4.900 escolheria a libra por ser "menor".
   */
  private async bestInTargetByDate(
    fares: LatestFaresByDate[],
    routine: RoutineRow,
  ): Promise<Map<string, { fare: LatestFaresByDate; cmp: Comparable }>> {
    const best = new Map<string, { fare: LatestFaresByDate; cmp: Comparable }>()
    for (const f of fares) {
      const cmp = await this.comparable(f, routine, 'outbound')
      if (cmp == null) continue
      if (!this.meetsTarget(cmp, routine)) continue
      const date = toDateStr(f.flight_date)
      const cur = best.get(date)
      if (cur == null || cmp.value < cur.cmp.value) best.set(date, { fare: f, cmp })
    }
    return best
  }

  /** O valor (já em Real, quando é dinheiro) cabe no alvo da rotina? */
  private meetsTarget(cmp: Comparable, routine: RoutineRow): boolean {
    const t = 1 + routine.margin
    if (routine.priority === 'cash') return routine.target_cash != null && cmp.value <= routine.target_cash * t
    if (routine.priority === 'pts')  return routine.target_pts != null && cmp.value <= routine.target_pts * t
    if (routine.priority === 'hyb') {
      if (routine.target_hyb_pts == null || routine.target_hyb_cash == null) return false
      if (cmp.hybCashBrl == null) return false
      return cmp.value <= routine.target_hyb_pts * t && cmp.hybCashBrl <= routine.target_hyb_cash * t
    }
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

  /**
   * A tarifa pronta para comparar, com dinheiro já em Real.
   *
   * O alvo da rotina é sempre em Real; a companhia cobra na moeda do mercado
   * dela. Sem esta conversão, £730 seria comparado com um alvo de R$5.000 e
   * passaria como pechincha.
   *
   * Pontos NÃO convertem: `PTS` é unidade do programa de fidelidade, não moeda.
   *
   * `null` quando não há cotação confiável — o par sai do ciclo e volta no
   * próximo. Alertar com número duvidoso é o único desfecho inaceitável.
   */
  private async comparable(
    fare: LatestFaresByDate,
    routine: RoutineRow,
    direction: PriceBreakdown['direction'],
  ): Promise<Comparable | null> {
    const raw = this.fareValue(fare, routine)
    if (raw == null) return null

    const currency = fare.currency ?? null
    // A composição guarda o que a companhia cobrou, sem conversão: é a
    // impressão digital do preço entre um ciclo e outro.
    const breakdown: PriceBreakdown = { direction, currency: currency ?? 'PTS', amount: raw }

    if (routine.priority === 'pts') {
      return { value: raw, hybCashBrl: null, breakdown, converted: false, rateDate: null }
    }

    if (routine.priority === 'cash') {
      if (currency == null) return null
      const conv = await this.fx.toBrl(raw, currency)
      if (conv == null) {
        log.warn({ routineId: routine.id, currency }, 'evaluation: sem cotação — tarifa fora do ciclo')
        return null
      }
      return {
        value: conv.amount, hybCashBrl: null, breakdown,
        converted: conv.source !== 'native', rateDate: conv.rateDate,
      }
    }

    // hyb: a dimensão comparada é pontos; a parte em dinheiro também vira Real.
    if (fare.fare_hyb_cash == null || currency == null) return null
    const conv = await this.fx.toBrl(Number(fare.fare_hyb_cash), currency)
    if (conv == null) {
      log.warn({ routineId: routine.id, currency }, 'evaluation: sem cotação para a parte em dinheiro do híbrido')
      return null
    }
    return {
      value: raw, hybCashBrl: conv.amount, breakdown,
      converted: conv.source !== 'native', rateDate: conv.rateDate,
    }
  }

  /**
   * O preço mudou de verdade, ou só o câmbio andou?
   *
   * Composição idêntica = a companhia cobra exatamente o mesmo, nas mesmas
   * moedas. Qualquer diferença no valor convertido veio da cotação, e anunciar
   * isso como "novo melhor preço" seria mentira — além de derrubar o watermark
   * e esconder a queda real que viesse depois.
   */
  private sameBreakdown(a: PriceBreakdown[] | null, b: PriceBreakdown[]): boolean {
    if (a == null || a.length !== b.length) return false
    return b.every((leg, i) =>
      a[i]!.direction === leg.direction &&
      a[i]!.currency === leg.currency &&
      Number(a[i]!.amount) === Number(leg.amount))
  }
}

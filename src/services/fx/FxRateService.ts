import { logger } from '../../utils/logger'
import { ConvertedAmount, IFxRateService } from './interfaces/IFxRateService'
import { IExchangeRateProvider } from './providers/IExchangeRateProvider'

const log = logger.child({ service: 'fx' })

/**
 * Plausibility range of a rate against BRL.
 *
 * It is the only protection this layer has against a SILENT failure. The others
 * fail loudly — timeout, invalid schema, refused host. An absurd quote passes
 * through and becomes a "price dropped" e-mail with nobody noticing.
 *
 * The bounds are deliberately loose: this is not about getting the rate right,
 * it is about blocking 0, negatives, infinity and a clearly wrong order of
 * magnitude (the pound at 0.0068 instead of 6.8, the classic scale error).
 */
const MIN_RATE = 0.0001
const MAX_RATE = 10_000

/** Consecutive failures before a provider is taken out of rotation. */
const BREAKER_THRESHOLD = 3
const BREAKER_COOLDOWN_MS = 5 * 60_000

interface CacheEntry {
  rate: number
  rateDate: string
  source: ConvertedAmount['source']
  /** The day (YYYY-MM-DD) on which this entry was fetched. */
  fetchedOn: string
}

interface BreakerState {
  failures: number
  openUntil: number
}

/**
 * Conversion to Real, with a one-day cache and fallback between providers.
 *
 * Persists nothing: by decision of the currency plan, no converted value goes to
 * the bank. What survives is the in-memory rate, valid for the current day.
 */
export class FxRateService implements IFxRateService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly breakers = new Map<string, BreakerState>()

  constructor(
    private readonly providers: IExchangeRateProvider[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Conversion between two currencies, with Real as the pivot.
   *
   * It exists so the pair TOTAL comes out in the outbound currency: the return is
   * brought to the departure currency, and the total never vanishes on divergence.
   */
  async convert(amount: number, from: string, to: string): Promise<ConvertedAmount | null> {
    const origem  = from?.toUpperCase()
    const destino = to?.toUpperCase()
    if (origem === destino) {
      return { amount, rate: 1, source: 'native', rateDate: this.today(), stale: false }
    }

    const emBrl = await this.toBrl(amount, origem)
    if (emBrl == null) return null
    if (destino === 'BRL') return emBrl

    // What 1 unit of the destination is worth in Real — the ratio gives the direct rate.
    const destinoEmBrl = await this.toBrl(1, destino)
    if (destinoEmBrl == null || destinoEmBrl.amount <= 0) return null

    const rate = emBrl.rate / destinoEmBrl.rate
    return {
      amount: Math.round((emBrl.amount / destinoEmBrl.amount) * 100) / 100,
      rate,
      source: emBrl.source,
      rateDate: emBrl.rateDate,
      stale: emBrl.stale || destinoEmBrl.stale,
    }
  }

  async toBrl(amount: number, currency: string): Promise<ConvertedAmount | null> {
    if (!Number.isFinite(amount)) return null

    const code = currency?.toUpperCase()
    if (!code || !/^[A-Z]{3}$/.test(code)) {
      log.warn({ currency }, 'fx: código de moeda inválido')
      return null
    }

    // Real does not convert, and above all does not hit the network: the most
    // common path of the system cannot depend on a third party being up.
    if (code === 'BRL') {
      return { amount, rate: 1, source: 'native', rateDate: this.today(), stale: false }
    }

    const cached = this.cache.get(code)
    if (cached && cached.fetchedOn === this.today()) {
      return this.applyRate(amount, cached, false)
    }

    for (const provider of this.providers) {
      if (this.isBreakerOpen(provider.source)) continue

      try {
        const { rate, rateDate } = await provider.fetchToBrl(code)

        if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
          // A rate outside the range is treated as a provider FAILURE, not as an
          // answer: it counts towards the breaker and falls through to the next.
          this.recordFailure(provider.source)
          log.error({ provider: provider.source, currency: code, rate }, 'fx: cotação fora da faixa de sanidade, recusada')
          continue
        }

        const entry: CacheEntry = { rate, rateDate, source: provider.source, fetchedOn: this.today() }
        this.cache.set(code, entry)
        this.recordSuccess(provider.source)
        log.info({ provider: provider.source, currency: code, rate, rateDate }, 'fx: cotação obtida')
        return this.applyRate(amount, entry, false)
      } catch (err) {
        this.recordFailure(provider.source)
        log.warn({ provider: provider.source, currency: code, err: String(err).slice(0, 200) }, 'fx: provedor falhou')
      }
    }

    // All failed. An old cache beats nothing, but the caller has to KNOW it is old
    // — hence `stale`, and not a number passing itself off as fresh.
    if (cached) {
      log.warn({ currency: code, rateDate: cached.rateDate }, 'fx: todos os provedores falharam, usando cotação anterior')
      return this.applyRate(amount, cached, true)
    }

    log.error({ currency: code }, 'fx: sem cotação disponível')
    return null
  }

  /** Applies a cached rate to the value. Named apart from the public `convert` on purpose. */
  private applyRate(amount: number, entry: CacheEntry, stale: boolean): ConvertedAmount {
    return {
    // Two decimals: it is money, and comparing a phantom cent with a target is noise.
      amount: Math.round(amount * entry.rate * 100) / 100,
      rate: entry.rate,
      source: entry.source,
      rateDate: entry.rateDate,
      stale,
    }
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10)
  }

  private isBreakerOpen(source: string): boolean {
    const b = this.breakers.get(source)
    if (!b) return false
    if (b.openUntil > this.now().getTime()) return true
    // Rest is over: reset and let it try again.
    if (b.openUntil !== 0) this.breakers.set(source, { failures: 0, openUntil: 0 })
    return false
  }

  private recordFailure(source: string): void {
    const b = this.breakers.get(source) ?? { failures: 0, openUntil: 0 }
    const failures = b.failures + 1
    const openUntil = failures >= BREAKER_THRESHOLD
      ? this.now().getTime() + BREAKER_COOLDOWN_MS
      : 0
    if (openUntil > 0) {
      log.warn({ provider: source, failures }, 'fx: provedor fora de circulação temporariamente')
    }
    this.breakers.set(source, { failures, openUntil })
  }

  private recordSuccess(source: string): void {
    this.breakers.delete(source)
  }
}

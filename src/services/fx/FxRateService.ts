import { logger } from '../../utils/logger'
import { ConvertedAmount, IFxRateService } from './interfaces/IFxRateService'
import { IExchangeRateProvider } from './providers/IExchangeRateProvider'

const log = logger.child({ service: 'fx' })

/**
 * Faixa de plausibilidade de uma taxa para BRL.
 *
 * É a única proteção desta camada contra uma falha SILENCIOSA. As outras
 * estouram barulhento — timeout, schema inválido, host recusado. Uma cotação
 * absurda passa e vira e-mail de "preço caiu" sem ninguém perceber.
 *
 * Os limites são folgados de propósito: não é para acertar o câmbio, é para
 * barrar 0, negativo, infinito e ordem de grandeza claramente errada (a libra a
 * 0,0068 em vez de 6,8, por exemplo, que é o erro clássico de escala).
 */
const MIN_RATE = 0.0001
const MAX_RATE = 10_000

/** Falhas seguidas antes de tirar um provedor de circulação. */
const BREAKER_THRESHOLD = 3
const BREAKER_COOLDOWN_MS = 5 * 60_000

interface CacheEntry {
  rate: number
  rateDate: string
  source: ConvertedAmount['source']
  /** O dia (YYYY-MM-DD) em que esta entrada foi buscada. */
  fetchedOn: string
}

interface BreakerState {
  failures: number
  openUntil: number
}

/**
 * Conversão para Real, com cache de um dia e fallback entre provedores.
 *
 * Não persiste nada: por decisão do plano da moeda, nenhum valor convertido vai
 * para o banco. O que sobrevive é a taxa em memória, válida pelo dia corrente.
 */
export class FxRateService implements IFxRateService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly breakers = new Map<string, BreakerState>()

  constructor(
    private readonly providers: IExchangeRateProvider[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  async toBrl(amount: number, currency: string): Promise<ConvertedAmount | null> {
    if (!Number.isFinite(amount)) return null

    const code = currency?.toUpperCase()
    if (!code || !/^[A-Z]{3}$/.test(code)) {
      log.warn({ currency }, 'fx: código de moeda inválido')
      return null
    }

    // Real não converte, e principalmente não vai à rede: o caminho mais comum
    // do sistema não pode depender de um terceiro estar de pé.
    if (code === 'BRL') {
      return { amount, rate: 1, source: 'native', rateDate: this.today(), stale: false }
    }

    const cached = this.cache.get(code)
    if (cached && cached.fetchedOn === this.today()) {
      return this.convert(amount, cached, false)
    }

    for (const provider of this.providers) {
      if (this.isBreakerOpen(provider.source)) continue

      try {
        const { rate, rateDate } = await provider.fetchToBrl(code)

        if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
          // Taxa fora da faixa é tratada como FALHA do provedor, não como
          // resposta: conta para o disjuntor e cai para o próximo.
          this.recordFailure(provider.source)
          log.error({ provider: provider.source, currency: code, rate }, 'fx: cotação fora da faixa de sanidade, recusada')
          continue
        }

        const entry: CacheEntry = { rate, rateDate, source: provider.source, fetchedOn: this.today() }
        this.cache.set(code, entry)
        this.recordSuccess(provider.source)
        log.info({ provider: provider.source, currency: code, rate, rateDate }, 'fx: cotação obtida')
        return this.convert(amount, entry, false)
      } catch (err) {
        this.recordFailure(provider.source)
        log.warn({ provider: provider.source, currency: code, err: String(err).slice(0, 200) }, 'fx: provedor falhou')
      }
    }

    // Todos falharam. Cache velho é melhor que nada, mas quem chama precisa
    // SABER que é velho — daí `stale`, e não um número que se passa por fresco.
    if (cached) {
      log.warn({ currency: code, rateDate: cached.rateDate }, 'fx: todos os provedores falharam, usando cotação anterior')
      return this.convert(amount, cached, true)
    }

    log.error({ currency: code }, 'fx: sem cotação disponível')
    return null
  }

  private convert(amount: number, entry: CacheEntry, stale: boolean): ConvertedAmount {
    return {
      // Duas casas: é dinheiro, e comparar centavo fantasma com alvo seria ruído.
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
    // Passou o descanso: zera e deixa tentar de novo.
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

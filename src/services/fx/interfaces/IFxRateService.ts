/** De onde a cotação veio. `native` = já era Real, não houve conversão. */
export type FxSource = 'frankfurter' | 'currency-api' | 'native'

export interface ConvertedAmount {
  /** O valor em BRL. */
  amount: number
  /** Quantos BRL vale 1 unidade da moeda de origem. 1 quando já era BRL. */
  rate: number
  source: FxSource
  /** A data DA COTAÇÃO, não a de hoje — o BCE publica em dia útil. */
  rateDate: string
  /**
   * A taxa veio de cache antigo porque todos os provedores falharam.
   *
   * Existe para quem chama poder decidir: alertar com número velho pode ser
   * pior que não alertar. A camada não decide isso sozinha.
   */
  stale: boolean
}

/**
 * Conversão de moeda para Real.
 *
 * Consumido SÓ por outro service ou controller — nenhuma rota expõe câmbio e
 * nenhum repositório fala com a rede. A garantia é de desenho: o service entra
 * por injeção no `container.ts` e a única classe que abre socket é o
 * `ExchangeRateHttpClient`.
 */
export interface IFxRateService {
  /**
   * Converte entre duas moedas quaisquer. `null` quando não há taxa confiável
   * para alguma das pontas.
   *
   * O pivô é o Real: as duas cotações que já temos em cache viram uma razão.
   * Assim não há um segundo conjunto de pares para manter, e a faixa de
   * sanidade continua sendo aplicada nas duas pontas.
   */
  convert(amount: number, from: string, to: string): Promise<ConvertedAmount | null>

  /**
   * Converte para BRL. Devolve `null` quando não há taxa confiável.
   *
   * `null` em vez de exceção de propósito: a avaliação precisa poder PULAR um
   * par sem derrubar o ciclo inteiro. Decidir alerta com número duvidoso é o
   * único desfecho que não pode acontecer.
   */
  toBrl(amount: number, currency: string): Promise<ConvertedAmount | null>
}

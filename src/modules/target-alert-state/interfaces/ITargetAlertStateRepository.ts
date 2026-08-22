/**
 * Uma parcela do preço, como a companhia cobrou — moeda original, valor
 * original. A composição do par é a lista dessas parcelas.
 *
 * É o que faz "o preço caiu" significar preço e não câmbio: com o alvo em Real,
 * o valor comparado é convertido, e os mesmos £730 valem R$4.986 a 6,83 e
 * R$4.818 a 6,60. Composição idêntica entre dois ciclos significa que a
 * companhia não mexeu em nada, por mais que a conversão tenha mudado.
 */
export interface PriceBreakdown {
  direction: 'outbound' | 'inbound'
  currency: string
  amount: number
}

export interface AlertWatermark {
  flightDate: string
  /** Valor já na unidade de comparação (BRL em rotina cash). */
  amount: number
  airline: string
  breakdown: PriceBreakdown[]
}

/** O que já foi alertado para uma data. */
export interface WatermarkState {
  amount: number
  /** `null` em linha gravada antes de a composição existir. */
  breakdown: PriceBreakdown[] | null
}

export interface ITargetAlertStateRepository {
  /** Watermarks (melhor preço já alertado) por data, para uma rotina + tipo de tarifa. */
  getWatermarks(routineId: string, fareType: string): Promise<Map<string, WatermarkState>>
  /**
   * Upsert monotônico-descendente: grava só onde o preço é novo ou menor que o já
   * alertado e devolve as datas que de fato avançaram. O banco decide o vencedor,
   * então ciclos sobrepostos não geram alerta em dobro (sem cooldown por tempo).
   */
  recordNotified(routineId: string, fareType: string, entries: AlertWatermark[]): Promise<Set<string>>
  /** Remove células de datas já passadas. Retorna quantas linhas saíram. */
  cleanupPastDates(): Promise<number>
  /** Zera o anti-repetição da rotina: ela volta a poder alertar do zero. */
  deleteByRoutine(routineId: string): Promise<number>
}

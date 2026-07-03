export interface AlertWatermark {
  flightDate: string
  amount: number
  airline: string
}

export interface ITargetAlertStateRepository {
  /** Watermarks (melhor preço já alertado) por data, para uma rotina + tipo de tarifa. */
  getWatermarks(routineId: string, fareType: string): Promise<Map<string, number>>
  /**
   * Upsert monotônico-descendente: grava só onde o preço é novo ou menor que o já
   * alertado e devolve as datas que de fato avançaram. O banco decide o vencedor,
   * então ciclos sobrepostos não geram alerta em dobro (sem cooldown por tempo).
   */
  recordNotified(routineId: string, fareType: string, entries: AlertWatermark[]): Promise<Set<string>>
  /** Remove células de datas já passadas. Retorna quantas linhas saíram. */
  cleanupPastDates(): Promise<number>
}

/**
 * One part of the price, as the airline charged it — original currency, original
 * value. The composition of the pair is the list of these parts.
 *
 * It is what makes "the price dropped" mean price and not exchange: with the
 * target in Real the compared value is converted, and the same £730 is worth
 * R$4,986 at 6.83 and R$4,818 at 6.60. An identical composition between two
 * cycles means the airline changed nothing, however much the conversion moved.
 */
export interface PriceBreakdown {
  direction: 'outbound' | 'inbound'
  currency: string
  amount: number
}

export interface AlertWatermark {
  flightDate: string
  /** Value already in the comparison unit (BRL on a cash routine). */
  amount: number
  airline: string
  breakdown: PriceBreakdown[]
}

/** What has already been alerted for a date. */
export interface WatermarkState {
  amount: number
  /** `null` on a row written before the composition existed. */
  breakdown: PriceBreakdown[] | null
}

export interface ITargetAlertStateRepository {
  /** Watermarks (best price already alerted) per date, for a routine + fare type. */
  getWatermarks(routineId: string, fareType: string): Promise<Map<string, WatermarkState>>
  /**
   * Monotonic-descending upsert: writes only where the price is new or lower than
   * the one already alerted, and returns the dates that actually advanced. The bank
   * picks the winner, so overlapping cycles raise no double alert (no time cooldown).
   */
  recordNotified(routineId: string, fareType: string, entries: AlertWatermark[]): Promise<Set<string>>
  /** Removes cells of dates already past. Returns how many rows went out. */
  cleanupPastDates(): Promise<number>
  /** Clears the anti-repetition of the routine: it can alert from scratch again. */
  deleteByRoutine(routineId: string): Promise<number>
}

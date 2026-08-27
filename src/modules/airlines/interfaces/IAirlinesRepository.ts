import { AirlineRow } from '../../../types'

/**
 * Why an airline is or is not recommended for a route.
 *
 * `outside_market` is the one this exists for. Until now the only answer was
 * "the airline lists both endpoints", which offers LATAM for a Madrid-Barcelona
 * flight: the list is bookable destinations with codeshare inside, not an
 * operated network. Traffic rights are what separate the two.
 */
export type RecommendationReason =
  /** Serves both endpoints AND holds traffic rights on one of them. */
  | 'serves_route'
  /** Lists both endpoints, but has no market on either end. */
  | 'outside_market'
  /** Does not list one of the endpoints at all. */
  | 'no_route'

export interface AirlineRecommendation extends AirlineRow {
  recommended: boolean
  reason: RecommendationReason
}

export interface IAirlinesRepository {
  findAll(): Promise<AirlineRow[]>
  findActive(): Promise<AirlineRow[]>
  /**
   * Every ACTIVE airline, each carrying whether it fits this route.
   *
   * Returns them all on purpose — the map decides the default, never the
   * ceiling. A user who disagrees can still pick a non-recommended airline, and
   * that is what makes the fail-closed rule safe: getting the map wrong costs a
   * click, not a lost offer.
   */
  findRecommendedForRoute(origin: string, destination: string): Promise<AirlineRecommendation[]>
  findByCode(code: string): Promise<AirlineRow | null>
  create(code: string, name: string): Promise<AirlineRow>
  setActive(code: string, active: boolean): Promise<AirlineRow | null>
  updateFareTypes(code: string, hasCash: boolean, hasPts: boolean, hasHyb: boolean): Promise<AirlineRow | null>
  delete(code: string): Promise<boolean>
}

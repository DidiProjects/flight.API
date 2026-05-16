import { RoutineRow } from '../../types'
import { IScrapeService } from './interfaces/IScrapeService'
import { IFlightOffersRepository } from './interfaces/IFlightOffersRepository'
import { IBestFaresRepository } from './interfaces/IBestFaresRepository'
import { IRoutinesRepository } from '../routines/interfaces/IRoutinesRepository'
import { INotificationsService } from '../../services/notifications/interfaces/INotificationsService'
import { ScrapeCallback, FlightOfferInput } from './schema'
import { MissingCurrencyError } from '../../utils/errors'
import { logger } from '../../utils/logger'

const log = logger.child({ service: 'scrape' })

export class ScrapeService implements IScrapeService {
  constructor(
    private readonly routinesRepo: IRoutinesRepository,
    private readonly offersRepo: IFlightOffersRepository,
    private readonly bestFaresRepo: IBestFaresRepository,
    private readonly notifSvc: INotificationsService,
  ) {}

  async processCallback(data: ScrapeCallback): Promise<void> {
    log.info({
      routineId: data.routineId,
      requestId: data.requestId,
      origin: data.origin,
      destination: data.destination,
      flightCount: data.flights.length,
      hasError: !!data.error,
      scrapedAt: data.scrapedAt,
    }, 'scrape callback received')

    const routine = await this.routinesRepo.findByIdAdmin(data.routineId)
    if (!routine) {
      log.warn({ routineId: data.routineId, requestId: data.requestId, origin: data.origin, destination: data.destination, status: 'error' }, 'callback ignored — routine not found')
      return
    }

    if (routine.pending_request_id !== data.requestId) {
      log.warn({
        routineId: routine.id,
        airline: routine.airline,
        origin: routine.origin,
        destination: routine.destination,
        expectedRequestId: routine.pending_request_id,
        receivedRequestId: data.requestId,
        status: 'error',
      }, 'callback ignored — requestId mismatch')
      return
    }

    if (this.isExpired(routine)) {
      log.warn({
        routineId: routine.id,
        airline: routine.airline,
        origin: routine.origin,
        destination: routine.destination,
        requestId: data.requestId,
        pendingAt: routine.pending_request_at,
        status: 'error',
      }, 'callback ignored — request expired (>1h), pending cleared')
      await this.routinesRepo.clearPendingRequest(routine.id)
      return
    }

    if (data.error && data.flights.length === 0) {
      log.error({
        routineId: routine.id,
        userId: routine.user_id,
        airline: routine.airline,
        origin: routine.origin,
        destination: routine.destination,
        requestId: data.requestId,
        scrapingError: data.error,
        status: 'error',
      }, 'scraping.API returned error — no flights')
      await this.routinesRepo.clearPendingRequest(routine.id)
      return
    }

    const validOffers = data.flights.filter(
      (f) => f.fareCash != null || f.farePts != null || f.fareHybPts != null,
    )

    if (validOffers.length === 0) {
      log.warn({
        routineId: routine.id,
        userId: routine.user_id,
        airline: routine.airline,
        origin: routine.origin,
        destination: routine.destination,
        requestId: data.requestId,
        rawFlightCount: data.flights.length,
        status: 'skipped',
      }, 'callback ignored — no flights with valid fares')
      await this.routinesRepo.clearPendingRequest(routine.id)
      return
    }

    const withinTargetCount = validOffers.filter((o) => this.withinTarget(o, routine)).length
    const startTime = Date.now()

    log.info({
      routineId: routine.id,
      userId: routine.user_id,
      airline: routine.airline,
      origin: routine.origin,
      destination: routine.destination,
      requestId: data.requestId,
      priority: routine.priority,
      flightsReceived: data.flights.length,
      validOffers: validOffers.length,
      withinTarget: withinTargetCount,
      status: 'success',
      duration_ms: Date.now() - startTime,
    }, 'processing flight offers')

    const ids = await this.offersRepo.insertMany(
      routine.id,
      routine.airline,
      validOffers,
      (offer) => this.withinTarget(offer, routine),
      data.scrapedAt,
    )

    const currency = validOffers.find((o) => o.currency)?.currency
    if (!currency) throw new MissingCurrencyError(routine.id)
    await this.bestFaresRepo.upsertFromOffers(routine.id, ids, currency, data.requestId)

    const inserted = await this.offersRepo.findByIds(ids)
    await this.notifSvc.evaluate(routine, inserted)

    await this.routinesRepo.clearPendingRequest(routine.id)
  }

  private isExpired(routine: RoutineRow): boolean {
    return (
      routine.pending_request_at != null &&
      routine.pending_request_at < new Date(Date.now() - 60 * 60 * 1000)
    )
  }

  private withinTarget(offer: FlightOfferInput, routine: RoutineRow): boolean {
    const t = 1 + routine.margin
    if (routine.priority === 'cash' && routine.target_cash  != null && offer.fareCash  != null)
      return offer.fareCash  <= routine.target_cash  * t
    if (routine.priority === 'pts' && routine.target_pts  != null && offer.farePts  != null)
      return offer.farePts  <= routine.target_pts  * t
    if (
      routine.priority === 'hyb' &&
      routine.target_hyb_pts != null && routine.target_hyb_cash != null &&
      offer.fareHybPts != null && offer.fareHybCash != null
    )
      return offer.fareHybPts <= routine.target_hyb_pts * t && offer.fareHybCash <= routine.target_hyb_cash * t
    return false
  }
}

import { RoutineRow } from '../../types'
import { IScrapeService } from './interfaces/IScrapeService'
import { IFlightOffersRepository } from './interfaces/IFlightOffersRepository'
import { IBestFaresRepository } from './interfaces/IBestFaresRepository'
import { IRoutinesRepository } from '../routines/interfaces/IRoutinesRepository'
import { INotificationsService } from '../../services/notifications/interfaces/INotificationsService'
import { ScrapeCallback, FlightOfferInput } from './schema'

export class ScrapeService implements IScrapeService {
  constructor(
    private readonly routinesRepo: IRoutinesRepository,
    private readonly offersRepo: IFlightOffersRepository,
    private readonly bestFaresRepo: IBestFaresRepository,
    private readonly notifSvc: INotificationsService,
  ) {}

  async processCallback(data: ScrapeCallback): Promise<void> {
    const routine = await this.routinesRepo.findByIdAdmin(data.routineId);
    if (!routine) return
    if (routine.pending_request_id !== data.requestId) return
    if (this.isExpired(routine)) { await this.routinesRepo.clearPendingRequest(routine.id); return }

    if (data.error && data.flights.length === 0) {
      await this.routinesRepo.clearPendingRequest(routine.id)
      return
    }

    const validOffers = data.flights.filter(
      (f) => f.fareBrl != null || f.farePts != null || f.fareHybPts != null,
    )
    if (validOffers.length === 0) { await this.routinesRepo.clearPendingRequest(routine.id); return }

    const ids = await this.offersRepo.insertMany(
      routine.id,
      routine.airline,
      validOffers,
      (offer) => this.withinTarget(offer, routine),
      data.scrapedAt,
    )

    await this.bestFaresRepo.upsertFromOffers(routine.id, ids)

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
    if (routine.priority === 'brl' && routine.target_brl  != null && offer.fareBrl  != null)
      return offer.fareBrl  <= routine.target_brl  * t
    if (routine.priority === 'pts' && routine.target_pts  != null && offer.farePts  != null)
      return offer.farePts  <= routine.target_pts  * t
    if (
      routine.priority === 'hyb' &&
      routine.target_hyb_pts != null && routine.target_hyb_brl != null &&
      offer.fareHybPts != null && offer.fareHybBrl != null
    )
      return offer.fareHybPts <= routine.target_hyb_pts * t && offer.fareHybBrl <= routine.target_hyb_brl * t
    return false
  }
}

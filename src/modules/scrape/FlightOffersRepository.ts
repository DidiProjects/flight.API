import { Pool } from 'pg'
import { FlightOfferRow } from '../../types'
import { IFlightOffersRepository } from './interfaces/IFlightOffersRepository'
import { FlightOfferInput } from './schema'

export class FlightOffersRepository implements IFlightOffersRepository {
  constructor(private readonly db: Pool) {}

  private buildTimestamp(date: string, time: string, referenceTime?: string): string {
    if (referenceTime && time < referenceTime) {
      const d = new Date(date)
      d.setUTCDate(d.getUTCDate() + 1)
      return `${d.toISOString().slice(0, 10)}T${time}:00`
    }
    return `${date}T${time}:00`
  }

  async insertMany(
    routineId: string,
    airline: string,
    offers: FlightOfferInput[],
    withinTargetFn: (offer: FlightOfferInput) => boolean,
    scrapedAt: string,
  ): Promise<string[]> {
    const ids: string[] = []
    for (const offer of offers) {
      const originTs = this.buildTimestamp(offer.date, offer.departureTime)
      const destTs   = this.buildTimestamp(offer.date, offer.arrivalTime, offer.departureTime)

      const { rows } = await this.db.query<{ id: string }>(
        `INSERT INTO flight_offers (
           routine_id, airline, flight_number, date, is_return,
           origin_iata, origin_timestamp, destination_iata, destination_timestamp,
           duration_min, stops, fare_brl, fare_pts, fare_hyb_pts, fare_hyb_brl,
           within_target, scraped_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id`,
        [
          routineId, airline, offer.flightNumber, offer.date, offer.isReturn,
          offer.origin, originTs, offer.destination, destTs,
          offer.durationMin, offer.stops,
          offer.fareBrl ?? null, offer.farePts ?? null,
          offer.fareHybPts ?? null, offer.fareHybBrl ?? null,
          withinTargetFn(offer), scrapedAt,
        ],
      )
      ids.push(rows[0].id)
    }
    return ids
  }

  async findByIds(ids: string[]): Promise<FlightOfferRow[]> {
    if (ids.length === 0) return []
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
    const { rows } = await this.db.query<FlightOfferRow>(
      `SELECT * FROM flight_offers WHERE id IN (${placeholders})`,
      ids,
    )
    return rows
  }
}

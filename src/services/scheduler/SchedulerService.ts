import { randomUUID } from 'crypto'
import { ISchedulerService } from './interfaces/ISchedulerService'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { INotificationsService } from '../notifications/interfaces/INotificationsService'
import { Env } from '../../config/env'
import { NotFoundError } from '../../utils/errors'
import { RoutineRow } from '../../types'

export class SchedulerService implements ISchedulerService {
  constructor(
    private readonly routinesRepo: IRoutinesRepository,
    private readonly notifSvc: INotificationsService,
    private readonly env: Env,
  ) {}

  start(): void {
    this.scheduleScrapeLoop()
    this.scheduleDailyJobs()
  }

  // ---------------------------------------------------------------------------
  // Scrape loop
  // ---------------------------------------------------------------------------

  private scheduleScrapeLoop(): void {
    const tick = async () => {
      try {
        await this.dispatchAll()
      } catch (err) {
        console.error('Scheduler scrape error:', err)
      } finally {
        const jitter = (Math.random() * 2 - 1) * this.env.SCRAPE_INTERVAL_JITTER_MS
        const delay  = Math.max(this.env.SCRAPE_INTERVAL_MS + jitter, 60_000)
        setTimeout(tick, delay)
      }
    }
    const initial = this.env.SCRAPE_INTERVAL_MS + Math.random() * this.env.SCRAPE_INTERVAL_JITTER_MS
    setTimeout(tick, initial)
  }

  async dispatchOne(id: string): Promise<void> {
    const routine = await this.routinesRepo.findByIdAdmin(id)
    if (!routine) throw new NotFoundError('Rotina não encontrada')
    await this.dispatchRoutine(routine)
  }

  private async dispatchAll(): Promise<void> {
    const routines = await this.routinesRepo.findDispatchable()
    for (const routine of routines) {
      try {
        await this.dispatchRoutine(routine)
      } catch (err) {
        console.error(`Dispatch failed for routine ${routine.id}:`, err)
      }
    }
  }

  private async dispatchRoutine(routine: RoutineRow): Promise<void> {
    const requestId = randomUUID()
    await this.routinesRepo.setPendingRequest(routine.id, requestId)
    try {
      const res = await fetch(`${this.env.SCRAPING_API_URL}/scrape`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.env.SCRAPING_API_KEY },
        body: JSON.stringify({
          requestId,
          routineId:     routine.id,
          airline:       routine.airline,
          origin:        routine.origin,
          destination:   routine.destination,
          outboundStart: routine.outbound_start,
          outboundEnd:   routine.outbound_end,
          returnStart:   routine.return_start ?? null,
          returnEnd:     routine.return_end   ?? null,
          passengers:    routine.passengers,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`scraping.API ${res.status}`)
    } catch (err) {
      await this.routinesRepo.clearPendingRequest(routine.id)
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // Daily jobs — tick every minute
  // ---------------------------------------------------------------------------

  private scheduleDailyJobs(): void {
    const tick = async () => {
      try {
        await this.notifSvc.sendEndOfPeriod()
        await this.maybeSendDailyBest()
      } catch (err) {
        console.error('Daily job error:', err)
      } finally {
        setTimeout(tick, 60_000)
      }
    }
    setTimeout(tick, 60_000)
  }

  private async maybeSendDailyBest(): Promise<void> {
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    const d = new Date(now)
    if (d.getHours() !== 8 || d.getMinutes() !== 0) return
    await this.notifSvc.sendDailyBest()
  }
}

import { randomUUID } from 'crypto'
import { ISchedulerService } from './interfaces/ISchedulerService'
import { IRoutinesRepository } from '../../modules/routines/interfaces/IRoutinesRepository'
import { INotificationsService } from '../notifications/interfaces/INotificationsService'
import { Env } from '../../config/env'
import { NotFoundError } from '../../utils/errors'
import { RoutineRow } from '../../types'
import { logger } from '../../utils/logger'

const log = logger.child({ service: 'scheduler' })

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
        log.error({ err }, 'Scheduler scrape error')
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
    const expired = await this.routinesRepo.deactivateExpired()
    if (expired > 0) log.info({ expired }, 'Scheduler: rotinas desativadas por data vencida')
    const routines = await this.routinesRepo.findDispatchable()
    log.info({ count: routines.length }, 'Scheduler: scrape cycle')
    for (const routine of routines) {
      try {
        await this.dispatchRoutine(routine)
      } catch {
        // error already logged in dispatchRoutine
      }
    }
  }

  private toDateStr(v: string | Date): string {
    return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
  }

  private async dispatchRoutine(routine: RoutineRow): Promise<void> {
    const requestId = randomUUID()
    await this.routinesRepo.setPendingRequest(routine.id, requestId)

    const payload = {
      requestId,
      routineId:     routine.id,
      airline:       routine.airline,
      origin:        routine.origin,
      destination:   routine.destination,
      outboundStart: this.toDateStr(routine.outbound_start),
      outboundEnd:   this.toDateStr(routine.outbound_end),
      ...(routine.return_start && { returnStart: this.toDateStr(routine.return_start) }),
      ...(routine.return_end   && { returnEnd:   this.toDateStr(routine.return_end) }),
      passengers:    routine.passengers,
    }

    log.info({ ...payload, userId: routine.user_id, routineName: routine.name }, 'dispatching to scraping.API')

    try {
      const res = await fetch(`${this.env.SCRAPING_API_URL}/scrape`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.env.SCRAPING_API_KEY },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`scraping.API ${res.status}: ${body}`)
      }
      log.info({ routineId: routine.id, userId: routine.user_id, requestId, status: res.status }, 'scraping.API accepted')
    } catch (err) {
      await this.routinesRepo.clearPendingRequest(routine.id)
      log.error({ err, routineId: routine.id, userId: routine.user_id, routineName: routine.name, requestId }, 'scraping.API request failed')
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
        log.error({ err }, 'Daily job error')
      } finally {
        setTimeout(tick, 60_000)
      }
    }
    setTimeout(tick, 60_000)
  }

  private async maybeSendDailyBest(): Promise<void> {
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    const d = new Date(now)
    if (d.getHours() !== 20 || d.getMinutes() !== 0) return
    await this.notifSvc.sendDailyBest()
  }
}

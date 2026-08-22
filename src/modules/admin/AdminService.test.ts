import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AdminService } from './AdminService'

function makeService() {
  const scrapingJobRepo = {
    setCancelRequested: vi.fn().mockResolvedValue(undefined),
    listForAdmin: vi.fn().mockResolvedValue([{ id: 'j1' }]),
    findByRequestId: vi.fn().mockResolvedValue({ id: 'j1', flight_date: '2026-08-15' }),
    releaseCancelled: vi.fn().mockResolvedValue(undefined),
  }
  const analysisRunsRepo = {
    setCancelledBy: vi.fn().mockResolvedValue(undefined),
    listEvents: vi.fn().mockResolvedValue([{ seq: 0 }]),
    markCancelled: vi.fn().mockResolvedValue(undefined),
  }
  const cancelDispatcher = { requestCancel: vi.fn() }
  const routinesRepo = {
    findByIdAdmin: vi.fn().mockResolvedValue({ id: 'r1', name: 'Suécia', user_id: 'u1' }),
  }
  const notifLogRepo = { findLastForRoutine: vi.fn() }
  const notifSvc = { resendDailySummary: vi.fn().mockResolvedValue(true) }
  const evaluationSvc = { resendAlert: vi.fn().mockResolvedValue(true) }
  const alertStateRepo = { deleteByRoutine: vi.fn().mockResolvedValue(3) }
  const svc = new AdminService(
    scrapingJobRepo as never, analysisRunsRepo as never, cancelDispatcher as never,
    routinesRepo as never, notifLogRepo as never, notifSvc as never,
    evaluationSvc as never, alertStateRepo as never,
  )
  return { svc, scrapingJobRepo, analysisRunsRepo, cancelDispatcher, routinesRepo, notifLogRepo, notifSvc, evaluationSvc, alertStateRepo }
}

describe('AdminService.cancelJob', () => {
  beforeEach(() => vi.clearAllMocks())

  it('registra intenção + auditoria e despacha quando há worker', async () => {
    const { svc, scrapingJobRepo, analysisRunsRepo, cancelDispatcher } = makeService()
    cancelDispatcher.requestCancel.mockResolvedValue({ delivery: 'dispatched', result: 'aborted' })

    const res = await svc.cancelJob('req-1', 'user-9')

    expect(scrapingJobRepo.setCancelRequested).toHaveBeenCalledWith('req-1')
    expect(analysisRunsRepo.setCancelledBy).toHaveBeenCalledWith('req-1', 'user-9')
    expect(cancelDispatcher.requestCancel).toHaveBeenCalledWith('req-1')
    expect(res).toEqual({ accepted: true, delivery: 'dispatched' })
  })

  it('sem worker dono → recupera o job na hora (recovered)', async () => {
    const { svc, scrapingJobRepo, analysisRunsRepo, cancelDispatcher } = makeService()
    cancelDispatcher.requestCancel.mockResolvedValue({ delivery: 'no_worker' })

    const res = await svc.cancelJob('req-2', 'user-9')

    expect(scrapingJobRepo.setCancelRequested).toHaveBeenCalledWith('req-2')
    expect(analysisRunsRepo.markCancelled).toHaveBeenCalledWith('req-2')
    expect(scrapingJobRepo.releaseCancelled).toHaveBeenCalledWith('req-2', expect.any(Date))
    expect(res).toEqual({ accepted: true, delivery: 'recovered' })
  })
})

describe('AdminService leitura', () => {
  it('listJobs e getJobEvents delegam aos repositórios', async () => {
    const { svc, scrapingJobRepo, analysisRunsRepo } = makeService()
    expect(await svc.listJobs()).toEqual([{ id: 'j1' }])
    expect(scrapingJobRepo.listForAdmin).toHaveBeenCalled()
    expect(await svc.getJobEvents('req-1')).toEqual([{ seq: 0 }])
    expect(analysisRunsRepo.listEvents).toHaveBeenCalledWith('req-1')
  })
})

/**
 * What these tests close: a resend has to go out IN THE SAME format as the last
 * e-mail the routine sent. Picking the wrong kind sends the daily summary to
 * someone expecting a target alert — and the operator only finds out from what
 * lands in the inbox.
 */
describe('AdminService.resendLastNotification', () => {
  beforeEach(() => vi.clearAllMocks())

  const lastOf = (type: string) => ({ type, sent_at: new Date('2026-08-21T23:00:00Z') })

  it('último foi alerta de target → reenvia alerta', async () => {
    const { svc, notifLogRepo, evaluationSvc, notifSvc } = makeService()
    notifLogRepo.findLastForRoutine.mockResolvedValue(lastOf('alert'))

    const res = await svc.resendLastNotification('r1')

    expect(evaluationSvc.resendAlert).toHaveBeenCalled()
    expect(notifSvc.resendDailySummary).not.toHaveBeenCalled()
    expect(res).toMatchObject({ type: 'alert', sent: true })
  })

  it('último foi resumo do dia → reenvia resumo', async () => {
    const { svc, notifLogRepo, evaluationSvc, notifSvc } = makeService()
    notifLogRepo.findLastForRoutine.mockResolvedValue(lastOf('scheduled'))

    const res = await svc.resendLastNotification('r1')

    expect(notifSvc.resendDailySummary).toHaveBeenCalled()
    expect(evaluationSvc.resendAlert).not.toHaveBeenCalled()
    expect(res).toMatchObject({ type: 'scheduled', sent: true })
  })

  it("'best_of_day' é o nome antigo do resumo e continua reenviando resumo", async () => {
    const { svc, notifLogRepo, notifSvc } = makeService()
    notifLogRepo.findLastForRoutine.mockResolvedValue(lastOf('best_of_day'))

    const res = await svc.resendLastNotification('r1')

    expect(notifSvc.resendDailySummary).toHaveBeenCalled()
    expect(res.type).toBe('scheduled')
  })

  it('sem oferta para montar o e-mail devolve o motivo, não um sucesso vazio', async () => {
    const { svc, notifLogRepo, evaluationSvc } = makeService()
    notifLogRepo.findLastForRoutine.mockResolvedValue(lastOf('alert'))
    evaluationSvc.resendAlert.mockResolvedValue(false)

    const res = await svc.resendLastNotification('r1')

    expect(res.sent).toBe(false)
    expect(res.reason).toMatch(/alvo/)
  })

  it('rotina que nunca enviou e-mail é 404', async () => {
    const { svc, notifLogRepo } = makeService()
    notifLogRepo.findLastForRoutine.mockResolvedValue(null)

    await expect(svc.resendLastNotification('r1')).rejects.toThrow('nunca enviou')
  })

  it('rotina inexistente é 404 antes de olhar o log', async () => {
    const { svc, routinesRepo, notifLogRepo } = makeService()
    routinesRepo.findByIdAdmin.mockResolvedValue(null)

    await expect(svc.resendLastNotification('r1')).rejects.toThrow('não encontrada')
    expect(notifLogRepo.findLastForRoutine).not.toHaveBeenCalled()
  })
})

describe('AdminService.resetRoutineAnalyses', () => {
  beforeEach(() => vi.clearAllMocks())

  it('devolve o saldo do que zerou e do que foi preservado', async () => {
    const { svc, analysisRunsRepo, scrapingJobRepo } = makeService()
    // @ts-expect-error partial fake
    analysisRunsRepo.deleteExclusiveToRoutine = vi.fn().mockResolvedValue({ runs: 12, events: 40, running: 1, shared: 2 })
    // @ts-expect-error partial fake
    scrapingJobRepo.resetExclusiveToRoutine = vi.fn().mockResolvedValue({ reset: 5, running: 1, shared: 2 })

    const res = await svc.resetRoutineAnalyses('r1')

    expect(res).toEqual({
      analysisRuns:    { deleted: 12, events: 40, keptRunning: 1, keptShared: 2 },
      scrapingJobs:    { reset: 5, keptRunning: 1, keptShared: 2 },
      alertWatermarks: { deleted: 3 },
    })
  })

  it('rotina inexistente é 404 e não apaga nada', async () => {
    const { svc, routinesRepo, alertStateRepo } = makeService()
    routinesRepo.findByIdAdmin.mockResolvedValue(null)

    await expect(svc.resetRoutineAnalyses('r1')).rejects.toThrow('não encontrada')
    expect(alertStateRepo.deleteByRoutine).not.toHaveBeenCalled()
  })
})

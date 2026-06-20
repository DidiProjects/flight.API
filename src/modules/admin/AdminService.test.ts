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
  const svc = new AdminService(scrapingJobRepo as never, analysisRunsRepo as never, cancelDispatcher as never)
  return { svc, scrapingJobRepo, analysisRunsRepo, cancelDispatcher }
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

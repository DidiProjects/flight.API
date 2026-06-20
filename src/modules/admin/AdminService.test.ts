import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../realtime/workerGateway', () => ({ requestCancel: vi.fn() }))
import { requestCancel } from '../../realtime/workerGateway'
import { AdminService } from './AdminService'

const mockedRequestCancel = vi.mocked(requestCancel)

function makeService() {
  const scrapingJobRepo = {
    setCancelRequested: vi.fn().mockResolvedValue(undefined),
    listForAdmin: vi.fn().mockResolvedValue([{ id: 'j1' }]),
  }
  const analysisRunsRepo = {
    setCancelledBy: vi.fn().mockResolvedValue(undefined),
    listEvents: vi.fn().mockResolvedValue([{ seq: 0 }]),
  }
  const svc = new AdminService(scrapingJobRepo as never, analysisRunsRepo as never)
  return { svc, scrapingJobRepo, analysisRunsRepo }
}

describe('AdminService.cancelJob', () => {
  beforeEach(() => vi.clearAllMocks())

  it('registra intenção + auditoria e despacha quando há worker', async () => {
    mockedRequestCancel.mockResolvedValue({ delivery: 'dispatched', result: 'aborted' })
    const { svc, scrapingJobRepo, analysisRunsRepo } = makeService()

    const res = await svc.cancelJob('req-1', 'user-9')

    expect(scrapingJobRepo.setCancelRequested).toHaveBeenCalledWith('req-1')
    expect(analysisRunsRepo.setCancelledBy).toHaveBeenCalledWith('req-1', 'user-9')
    expect(mockedRequestCancel).toHaveBeenCalledWith('req-1')
    expect(res).toEqual({ accepted: true, delivery: 'dispatched' })
  })

  it('mapeia no_worker → queued (worker offline, intenção persistida)', async () => {
    mockedRequestCancel.mockResolvedValue({ delivery: 'no_worker' })
    const { svc, scrapingJobRepo } = makeService()

    const res = await svc.cancelJob('req-2', 'user-9')

    // a intenção é gravada mesmo sem worker conectado
    expect(scrapingJobRepo.setCancelRequested).toHaveBeenCalledWith('req-2')
    expect(res).toEqual({ accepted: true, delivery: 'queued' })
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

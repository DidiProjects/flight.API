import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RealtimePersistence } from './realtimePersistence'
import { HubBus } from './hubBus'
import { envelope } from './protocol'

const tick = () => new Promise((r) => setTimeout(r, 10))

const analysisRunsRepo = {
  appendEvent: vi.fn().mockResolvedValue(undefined),
  markCancelled: vi.fn().mockResolvedValue(undefined),
}
const scrapingJobRepo = {
  findByRequestId: vi.fn().mockResolvedValue({ id: 'j1', flight_date: '2026-08-15' }),
  releaseCancelled: vi.fn().mockResolvedValue(undefined),
}

const hubBus = new HubBus()

beforeEach(() => vi.clearAllMocks())

new RealtimePersistence(hubBus, analysisRunsRepo as never, scrapingJobRepo as never).start()

describe('realtimePersistence', () => {
  it('grava cada evento job.* na timeline (mapeando o tipo)', async () => {
    hubBus.publishTelemetry({ workerId: 'w', message: envelope('job.started', { airline: 'azul' }, { requestId: 'r1', seq: 1 }) })
    await tick()
    expect(analysisRunsRepo.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'r1', seq: 1, type: 'started' }),
    )
  })

  it('job.finished cancelled marca a execução e libera o job (única fonte, sem webhook)', async () => {
    hubBus.publishTelemetry({ workerId: 'w', message: envelope('job.finished', { status: 'cancelled' }, { requestId: 'r2', seq: 5 }) })
    await tick()
    expect(analysisRunsRepo.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'finished' }))
    expect(analysisRunsRepo.markCancelled).toHaveBeenCalledWith('r2')
    expect(scrapingJobRepo.findByRequestId).toHaveBeenCalledWith('r2')
    expect(scrapingJobRepo.releaseCancelled).toHaveBeenCalledWith('r2', expect.any(Date))
  })

  it('job.finished success NÃO mexe no status (dono é o webhook), só grava timeline', async () => {
    hubBus.publishTelemetry({ workerId: 'w', message: envelope('job.finished', { status: 'success', faresFound: 3 }, { requestId: 'r3', seq: 2 }) })
    await tick()
    expect(analysisRunsRepo.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'finished' }))
    expect(analysisRunsRepo.markCancelled).not.toHaveBeenCalled()
    expect(scrapingJobRepo.releaseCancelled).not.toHaveBeenCalled()
  })

  it('ignora mensagens sem requestId', async () => {
    hubBus.publishTelemetry({ workerId: 'w', message: envelope('worker.heartbeat', { activeJobs: [] }) })
    await tick()
    expect(analysisRunsRepo.appendEvent).not.toHaveBeenCalled()
  })
})

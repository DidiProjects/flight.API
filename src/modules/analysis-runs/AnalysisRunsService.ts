import { IRoutinesRepository } from '../routines/interfaces/IRoutinesRepository'
import { IAnalysisRunsRepository, AnalysisRunRow } from './interfaces/IAnalysisRunsRepository'
import { toDateStr } from '../../services/evaluation/EvaluationService'

export interface IAnalysisRunsService {
  listByRoutine(routineId: string): Promise<AnalysisRunRow[]>
}

export class AnalysisRunsService implements IAnalysisRunsService {
  constructor(
    private readonly routinesRepo: IRoutinesRepository,
    private readonly analysisRunsRepo: IAnalysisRunsRepository,
  ) {}

  async listByRoutine(routineId: string): Promise<AnalysisRunRow[]> {
    const routine = await this.routinesRepo.findByIdAdmin(routineId)
    if (!routine) return []

    return this.analysisRunsRepo.listByRoutineMatch({
      airlines:      routine.airlines,
      origin:        routine.origin,
      destination:   routine.destination,
      outboundStart: toDateStr(routine.outbound_start),
      outboundEnd:   toDateStr(routine.outbound_end),
    })
  }
}

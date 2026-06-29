export interface IEvaluationService {
  runCycle(): Promise<void>
  /** Limpa watermarks de datas já passadas. Retorna quantas linhas saíram. */
  cleanupAlertState(): Promise<number>
}

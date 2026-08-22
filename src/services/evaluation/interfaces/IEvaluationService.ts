import { RoutineRow } from '../../../types'

export interface IEvaluationService {
  runCycle(): Promise<void>
  /** Limpa watermarks de datas já passadas. Retorna quantas linhas saíram. */
  cleanupAlertState(): Promise<number>
  /**
   * Reenvia o alerta de target da rotina com os dados atuais, sem os gates de
   * anti-repetição e sem mexer no watermark. `false` quando não há oferta no
   * alvo para montar o e-mail.
   */
  resendAlert(routine: RoutineRow): Promise<boolean>
}

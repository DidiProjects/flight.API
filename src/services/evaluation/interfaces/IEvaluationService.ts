import { RoutineRow } from '../../../types'

export interface IEvaluationService {
  runCycle(): Promise<void>
  /** Clears watermarks of dates already past. Returns how many rows went out. */
  cleanupAlertState(): Promise<number>
  /**
   * Resends the target alert of the routine with current data, with no
   * anti-repetition gates and without touching the watermark. `false` when there is
   * no offer within target to build the e-mail from.
   */
  resendAlert(routine: RoutineRow): Promise<boolean>
}

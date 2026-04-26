export interface ISchedulerService {
  start(): void
  dispatchOne(id: string): Promise<void>
}

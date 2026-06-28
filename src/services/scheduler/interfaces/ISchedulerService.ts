export interface ISchedulerService {
  start(): void
  stop(): void
  dispatchOne(id: string): Promise<void>
  pruneOrphans(): Promise<void>
}

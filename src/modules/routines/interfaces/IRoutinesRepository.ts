import { RoutineRow } from '../../../types'

export interface CreateRoutineData {
  userId: string
  name: string
  airline: string
  origin: string
  destination: string
  outboundStart: string
  outboundEnd: string
  returnStart?: string | null
  returnEnd?: string | null
  passengers: number
  targetBrl?: number | null
  targetPts?: number | null
  targetHybPts?: number | null
  targetHybBrl?: number | null
  margin: number
  priority: string
  notificationMode: string
  notificationFrequency: string
  endOfPeriodTime?: string | null
  ccEmails: string[]
}

export interface IRoutinesRepository {
  findByUser(userId: string): Promise<RoutineRow[]>
  findById(id: string, userId: string): Promise<RoutineRow | null>
  findByIdAdmin(id: string): Promise<RoutineRow | null>
  countByUser(userId: string): Promise<number>
  findDispatchable(): Promise<RoutineRow[]>
  findActiveForEndOfPeriod(currentTime: string): Promise<RoutineRow[]>
  findActiveForDailyBest(): Promise<RoutineRow[]>
  create(data: CreateRoutineData): Promise<RoutineRow>
  update(id: string, userId: string, fields: Partial<CreateRoutineData>): Promise<RoutineRow | null>
  delete(id: string, userId: string): Promise<boolean>
  setActive(id: string, userId: string, active: boolean): Promise<RoutineRow | null>
  setPendingRequest(id: string, requestId: string): Promise<void>
  clearPendingRequest(id: string): Promise<void>
}

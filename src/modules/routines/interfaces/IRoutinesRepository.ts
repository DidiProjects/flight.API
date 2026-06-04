import { RoutineRow } from '../../../types'

export interface CreateRoutineData {
  userId: string
  name: string
  airlines: string[]
  origin: string
  destination: string
  outboundStart: string
  outboundEnd: string
  returnStart?: string | null
  returnEnd?: string | null
  passengers: number
  currency: string
  targetCash?: number | null
  targetPts?: number | null
  targetHybPts?: number | null
  targetHybCash?: number | null
  margin: number
  priority: string
  notificationModes: string[]
  notificationFrequency: string
  scheduledTime?: string | null
  ccEmails: string[]
  isActive?: boolean
}

export interface IRoutinesRepository {
  findByUser(userId: string): Promise<RoutineRow[]>
  findById(id: string, userId: string): Promise<RoutineRow | null>
  findByIdAdmin(id: string): Promise<RoutineRow | null>
  countByUser(userId: string): Promise<number>
  findDispatchable(): Promise<RoutineRow[]>
  findActiveForScheduled(currentTime: string): Promise<RoutineRow[]>
  create(data: CreateRoutineData): Promise<RoutineRow>
  update(id: string, userId: string, fields: Partial<CreateRoutineData>): Promise<RoutineRow | null>
  delete(id: string, userId: string): Promise<boolean>
  deleteAdmin(id: string): Promise<boolean>
  setActive(id: string, userId: string, active: boolean): Promise<RoutineRow | null>
  setActiveAdmin(id: string, active: boolean): Promise<RoutineRow | null>
  deactivateByAirline(airlineCode: string): Promise<void>
  deleteByAirline(airlineCode: string): Promise<void>
  deactivateExpired(): Promise<number>
  setPendingRequest(routineId: string, airline: string, requestId: string): Promise<void>
  clearPendingRequest(routineId: string, airline: string): Promise<void>
  getPendingRequest(routineId: string, airline: string): Promise<{ request_id: string; requested_at: Date } | null>
  hasPendingRequests(routineId: string): Promise<boolean>
}

import { RoutineRow } from '../../../types'
import { CreateRoutineData } from './IRoutinesRepository'

export interface IRoutinesService {
  list(userId: string): Promise<RoutineRow[]>
  get(id: string, userId: string): Promise<RoutineRow>
  create(userId: string, data: Omit<CreateRoutineData, 'userId'>): Promise<RoutineRow>
  update(id: string, userId: string, fields: Partial<Omit<CreateRoutineData, 'userId'>>): Promise<RoutineRow>
  remove(id: string, userId: string): Promise<void>
  activate(id: string, userId: string): Promise<RoutineRow>
  deactivate(id: string, userId: string): Promise<RoutineRow>
}

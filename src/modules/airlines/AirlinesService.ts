import { AirlineRow } from '../../types'
import { IAirlinesService } from './interfaces/IAirlinesService'
import { IAirlinesRepository } from './interfaces/IAirlinesRepository'
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors'

export class AirlinesService implements IAirlinesService {
  constructor(private readonly airlinesRepo: IAirlinesRepository) {}

  async listActive(): Promise<AirlineRow[]> {
    return this.airlinesRepo.findActive()
  }

  async listAll(): Promise<AirlineRow[]> {
    return this.airlinesRepo.findAll()
  }

  async create(code: string, name: string): Promise<AirlineRow> {
    const existing = await this.airlinesRepo.findByCode(code)
    if (existing) throw new ConflictError(`Companhia '${code}' já cadastrada`)
    return this.airlinesRepo.create(code, name)
  }

  async activate(code: string): Promise<AirlineRow> {
    const airline = await this.airlinesRepo.setActive(code, true)
    if (!airline) throw new NotFoundError('Companhia aérea não encontrada')
    return airline
  }

  async deactivate(code: string): Promise<AirlineRow> {
    const airline = await this.airlinesRepo.setActive(code, false)
    if (!airline) throw new NotFoundError('Companhia aérea não encontrada')
    return airline
  }

  async updateFareTypes(code: string, hasBrl: boolean, hasPts: boolean, hasHyb: boolean): Promise<AirlineRow> {
    const airline = await this.airlinesRepo.updateFareTypes(code, hasBrl, hasPts, hasHyb)
    if (!airline) throw new NotFoundError('Companhia aérea não encontrada')
    return airline
  }

  async remove(code: string): Promise<void> {
    const existing = await this.airlinesRepo.findByCode(code)
    if (!existing) throw new NotFoundError('Companhia aérea não encontrada')
    const deleted = await this.airlinesRepo.delete(code)
    if (!deleted) throw new BadRequestError('Não foi possível remover a companhia aérea')
  }
}

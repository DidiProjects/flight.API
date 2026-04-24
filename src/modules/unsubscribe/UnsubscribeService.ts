import { Pool } from 'pg'
import { IUnsubscribeService, UnsubscribeResult } from './interfaces/IUnsubscribeService'
import { IUnsubscribeTokensRepository } from './interfaces/IUnsubscribeTokensRepository'
import { IRoutinesRepository } from '../routines/interfaces/IRoutinesRepository'
import { BadRequestError, NotFoundError } from '../../utils/errors'

export class UnsubscribeService implements IUnsubscribeService {
  constructor(
    private readonly unsubTokensRepo: IUnsubscribeTokensRepository,
    private readonly routinesRepo: IRoutinesRepository,
    private readonly db: Pool,
  ) {}

  async process(token: string): Promise<UnsubscribeResult> {
    const rec = await this.unsubTokensRepo.findByToken(token)
    if (!rec)        throw new NotFoundError('Token inválido')
    if (rec.used_at) throw new BadRequestError('Este link já foi utilizado')
    if (rec.expires_at < new Date()) throw new BadRequestError('Link expirado')

    await this.unsubTokensRepo.markUsed(rec.id)

    if (rec.is_primary) {
      await this.db.query(
        `UPDATE routines SET is_active = false, updated_at = now() WHERE id = $1`,
        [rec.routine_id],
      )
    } else {
      await this.db.query(
        `UPDATE routines
         SET cc_emails = (
           SELECT jsonb_agg(
             CASE WHEN (elem->>'email') = $2
               THEN jsonb_set(elem, '{subscribed}', 'false')
               ELSE elem
             END
           ) FROM jsonb_array_elements(cc_emails) AS elem
         ), updated_at = now()
         WHERE id = $1`,
        [rec.routine_id, rec.email],
      )
    }

    return { email: rec.email, routineName: rec.routine_name, isPrimary: rec.is_primary }
  }
}

import { Pool } from 'pg'
import { IUnsubscribeService, UnsubscribeResult } from './interfaces/IUnsubscribeService'
import { IUnsubscribeTokensRepository } from './interfaces/IUnsubscribeTokensRepository'
import { IRoutinesRepository } from '../routines/interfaces/IRoutinesRepository'
import { UnsubscribeTokenRow } from '../../types'
import { BadRequestError, NotFoundError } from '../../utils/errors'

export class UnsubscribeService implements IUnsubscribeService {
  constructor(
    private readonly unsubTokensRepo: IUnsubscribeTokensRepository,
    private readonly routinesRepo: IRoutinesRepository,
    private readonly db: Pool,
  ) {}

  async process(token: string): Promise<UnsubscribeResult> {
    const rec = await this.unsubTokensRepo.findByToken(token)
    if (!rec) throw new NotFoundError('Token inválido')

    const spent = Boolean(rec.used_at) || rec.expires_at < new Date()

    if (!spent) {
      await this.unsubTokensRepo.markUsed(rec.id)
      if (rec.is_primary) await this.deactivateRoutine(rec.routine_id)
      else                await this.unsubscribeCc(rec.routine_id, rec.email)
    }

    // A spent token is not necessarily an error: it is usually the second click
    // on the same link, or an older e-mail's link followed after a newer one.
    // What decides is the current state of the subscription, not the token's —
    // it only reads as subscribed again if the owner re-enabled the routine, and
    // then the spent link really is of no use.
    if (await this.isSubscribed(rec)) {
      throw new BadRequestError(rec.used_at ? 'Este link já foi utilizado' : 'Link expirado')
    }

    return {
      email:       rec.email,
      routineName: rec.routine_name,
      isPrimary:   rec.is_primary,
      alreadyUnsubscribed: spent,
    }
  }

  private async deactivateRoutine(routineId: string): Promise<void> {
    await this.db.query(
      `UPDATE routines SET is_active = false, updated_at = now() WHERE id = $1`,
      [routineId],
    )
  }

  private async unsubscribeCc(routineId: string, email: string): Promise<void> {
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
      [routineId, email],
    )
  }

  private async isSubscribed(rec: UnsubscribeTokenRow): Promise<boolean> {
    if (rec.is_primary) {
      const { rows } = await this.db.query<{ is_active: boolean }>(
        `SELECT is_active FROM routines WHERE id = $1`,
        [rec.routine_id],
      )
      return rows[0]?.is_active === true
    }

    const { rows } = await this.db.query<{ subscribed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM jsonb_array_elements(cc_emails) AS elem
         WHERE (elem->>'email') = $2 AND (elem->>'subscribed')::boolean
       ) AS subscribed
       FROM routines WHERE id = $1`,
      [rec.routine_id, rec.email],
    )
    return rows[0]?.subscribed === true
  }
}

import { FastifyInstance } from 'fastify'
import { IRoutinesService } from './interfaces/IRoutinesService'
import { ISchedulerService } from '../../services/scheduler/interfaces/ISchedulerService'
import { IBestFaresRepository } from '../scrape/interfaces/IBestFaresRepository'
import { BestFareRow, RoutineRow } from '../../types'
import { createRoutineSchema, updateRoutineSchema } from './schema'

function formatFare(bf: BestFareRow) {
  return {
    amount:     bf.amount,
    currency:   bf.currency,
    date:       bf.date,
    updatedAt:  bf.updated_at,
    analysisId: bf.analysis_id,
    offer: {
      flightNumber:  bf.offer.flight_number,
      departureTime: bf.offer.origin_timestamp,
      arrivalTime:   bf.offer.destination_timestamp,
      durationMin:   bf.offer.duration_min,
      stops:         bf.offer.stops,
    },
  }
}

async function buildBestFaresResult(routine: RoutineRow, bestFaresRepo: IBestFaresRepository) {
  const [outbound, ret] = await Promise.all([
    bestFaresRepo.getBest(routine.id, false, routine.priority),
    routine.return_start
      ? bestFaresRepo.getBest(routine.id, true, routine.priority)
      : Promise.resolve(null),
  ])
  return {
    routineId:   routine.id,
    routineName: routine.name,
    origin:      routine.origin,
    destination: routine.destination,
    priority:    routine.priority,
    isActive:    routine.is_active,
    outbound:    outbound ? formatFare(outbound) : null,
    return:      ret      ? formatFare(ret)      : null,
  }
}

export function routinesRoute(routinesSvc: IRoutinesService, schedulerSvc: ISchedulerService, bestFaresRepo: IBestFaresRepository) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.addHook('preHandler', app.authenticate)
    app.addHook('preHandler', app.requirePasswordChanged)

    app.get('/', async (req, reply) => {
      reply.send(await routinesSvc.list(req.user.sub))
    })

    app.post('/', async (req, reply) => {
      const body = createRoutineSchema.parse(req.body)
      const routine = await routinesSvc.create(req.user.sub, {
        name:                  body.name,
        airline:               body.airline,
        origin:                body.origin,
        destination:           body.destination,
        outboundStart:         body.outboundStart,
        outboundEnd:           body.outboundEnd,
        returnStart:           body.returnStart   ?? null,
        returnEnd:             body.returnEnd     ?? null,
        passengers:            body.passengers,
        currency:              body.currency,
        targetCash:            body.targetCash    ?? null,
        targetPts:             body.targetPts     ?? null,
        targetHybPts:          body.targetHybPts  ?? null,
        targetHybCash:         body.targetHybCash ?? null,
        margin:                body.margin,
        priority:              body.priority,
        notificationMode:      body.notificationMode,
        notificationFrequency: body.notificationFrequency,
        endOfPeriodTime:       body.endOfPeriodTime ?? null,
        ccEmails:              body.ccEmails,
        isActive:              body.isActive,
      })
      reply.status(201).send(routine)
    })

    app.get('/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      reply.send(await routinesSvc.get(id, req.user.sub))
    })

    app.patch('/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = updateRoutineSchema.parse(req.body)
      reply.send(await routinesSvc.update(id, req.user.sub, {
        name:                  body.name,
        airline:               body.airline,
        origin:                body.origin,
        destination:           body.destination,
        outboundStart:         body.outboundStart,
        outboundEnd:           body.outboundEnd,
        returnStart:           body.returnStart   ?? null,
        returnEnd:             body.returnEnd     ?? null,
        passengers:            body.passengers,
        currency:              body.currency,
        targetCash:            body.targetCash    ?? null,
        targetPts:             body.targetPts     ?? null,
        targetHybPts:          body.targetHybPts  ?? null,
        targetHybCash:         body.targetHybCash ?? null,
        margin:                body.margin,
        priority:              body.priority,
        notificationMode:      body.notificationMode,
        notificationFrequency: body.notificationFrequency,
        endOfPeriodTime:       body.endOfPeriodTime ?? null,
        ccEmails:              body.ccEmails,
        isActive:              body.isActive,
      }))
    })

    app.delete('/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (req.user.role === 'admin') {
        await routinesSvc.adminRemove(id)
      } else {
        await routinesSvc.remove(id, req.user.sub)
      }
      reply.status(204).send()
    })

    app.patch('/:id/activate', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (req.user.role === 'admin') {
        reply.send(await routinesSvc.adminActivate(id))
      } else {
        reply.send(await routinesSvc.activate(id, req.user.sub))
      }
    })

    app.patch('/:id/deactivate', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (req.user.role === 'admin') {
        reply.send(await routinesSvc.adminDeactivate(id))
      } else {
        reply.send(await routinesSvc.deactivate(id, req.user.sub))
      }
    })

    app.get('/admin/users/:userId', { preHandler: [app.requireAdmin] }, async (req, reply) => {
      const { userId } = req.params as { userId: string }
      reply.send(await routinesSvc.listByUser(userId))
    })

    app.get('/admin/users/:userId/best-fares', { preHandler: [app.requireAdmin] }, async (req, reply) => {
      const { userId } = req.params as { userId: string }
      const routines = await routinesSvc.listByUser(userId)
      const results = await Promise.all(routines.map((r) => buildBestFaresResult(r, bestFaresRepo)))
      reply.send(results)
    })

    app.post('/:id/dispatch', { preHandler: [app.requireAdmin] }, async (req, reply) => {
      const { id } = req.params as { id: string }
      await schedulerSvc.dispatchOne(id)
      reply.status(202).send({ message: 'Dispatch iniciado' })
    })
  }
}

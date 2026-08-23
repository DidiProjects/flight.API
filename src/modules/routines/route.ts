import { FastifyInstance } from 'fastify'
import { IRoutinesService } from './interfaces/IRoutinesService'
import { ISchedulerService } from '../../services/scheduler/interfaces/ISchedulerService'
import { IAnalysisRunsService } from '../analysis-runs/AnalysisRunsService'
import { createRoutineSchema, updateRoutineSchema } from './schema'

export function routinesRoute(
  routinesSvc: IRoutinesService,
  schedulerSvc: ISchedulerService,
  analysisRunsSvc: IAnalysisRunsService,
) {
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
        airlines:              body.airlines,
        origin:                body.origin,
        destination:           body.destination,
        outboundStart:         body.outboundStart,
        outboundEnd:           body.outboundEnd,
        tripType:              body.tripType,
        inboundStart:          body.inboundStart,
        inboundEnd:            body.inboundEnd,
        passengers:            body.passengers,
        targetCash:            body.targetCash,
        targetPts:             body.targetPts,
        targetHybPts:          body.targetHybPts,
        targetHybCash:         body.targetHybCash,
        margin:                body.margin,
        priority:              body.priority,
        notificationModes:     body.notificationModes,
        notificationFrequency: body.notificationFrequency,
        scheduledTime:         body.scheduledTime,
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
        airlines:              body.airlines,
        origin:                body.origin,
        destination:           body.destination,
        outboundStart:         body.outboundStart,
        outboundEnd:           body.outboundEnd,
        tripType:              body.tripType,
        inboundStart:          body.inboundStart,
        inboundEnd:            body.inboundEnd,
        passengers:            body.passengers,
        targetCash:            body.targetCash,
        targetPts:             body.targetPts,
        targetHybPts:          body.targetHybPts,
        targetHybCash:         body.targetHybCash,
        margin:                body.margin,
        priority:              body.priority,
        notificationModes:     body.notificationModes,
        notificationFrequency: body.notificationFrequency,
        scheduledTime:         body.scheduledTime,
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
      void schedulerSvc.pruneOrphans()
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
      const routine = req.user.role === 'admin'
        ? await routinesSvc.adminDeactivate(id)
        : await routinesSvc.deactivate(id, req.user.sub)
      void schedulerSvc.pruneOrphans()
      reply.send(routine)
    })

    app.patch('/admin/:id', { preHandler: [app.requireAdmin] }, async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = updateRoutineSchema.parse(req.body)
      reply.send(await routinesSvc.adminUpdateRoutine(id, {
        name:                  body.name,
        airlines:              body.airlines,
        origin:                body.origin,
        destination:           body.destination,
        outboundStart:         body.outboundStart,
        outboundEnd:           body.outboundEnd,
        tripType:              body.tripType,
        inboundStart:          body.inboundStart,
        inboundEnd:            body.inboundEnd,
        passengers:            body.passengers,
        targetCash:            body.targetCash,
        targetPts:             body.targetPts,
        targetHybPts:          body.targetHybPts,
        targetHybCash:         body.targetHybCash,
        margin:                body.margin,
        priority:              body.priority,
        notificationModes:     body.notificationModes,
        notificationFrequency: body.notificationFrequency,
        scheduledTime:         body.scheduledTime,
        ccEmails:              body.ccEmails,
        isActive:              body.isActive,
      }))
    })

    app.get('/admin/users/:userId', { preHandler: [app.requireAdmin] }, async (req, reply) => {
      const { userId } = req.params as { userId: string }
      reply.send(await routinesSvc.listByUser(userId))
    })

    app.get('/admin/:id/analysis-runs', { preHandler: [app.requireAdmin] }, async (req, reply) => {
      const { id } = req.params as { id: string }
      reply.send(await analysisRunsSvc.listByRoutine(id))
    })

    app.post('/:id/dispatch', { preHandler: [app.requireAdmin] }, async (req, reply) => {
      const { id } = req.params as { id: string }
      // Async 202: the dispatch covers every eligible date of the routine and may
      // make several sequential calls to the scraper. It runs in the background so
      // the request is not held in the loop; errors go to the log, not the response.
      void schedulerSvc.dispatchOne(id).catch((err) => {
        req.log.error({ err, routineId: id }, 'manual dispatch failed')
      })
      reply.status(202).send({ message: 'Dispatch iniciado' })
    })
  }
}

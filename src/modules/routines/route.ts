import { FastifyInstance } from 'fastify'
import { IRoutinesService } from './interfaces/IRoutinesService'
import { ISchedulerService } from '../../services/scheduler/interfaces/ISchedulerService'
import { createRoutineSchema, updateRoutineSchema } from './schema'

export function routinesRoute(routinesSvc: IRoutinesService, schedulerSvc: ISchedulerService) {
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
        targetBrl:             body.targetBrl     ?? null,
        targetPts:             body.targetPts     ?? null,
        targetHybPts:          body.targetHybPts  ?? null,
        targetHybBrl:          body.targetHybBrl  ?? null,
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
        targetBrl:             body.targetBrl     ?? null,
        targetPts:             body.targetPts     ?? null,
        targetHybPts:          body.targetHybPts  ?? null,
        targetHybBrl:          body.targetHybBrl  ?? null,
        margin:                body.margin,
        priority:              body.priority,
        notificationMode:      body.notificationMode,
        notificationFrequency: body.notificationFrequency,
        endOfPeriodTime:       body.endOfPeriodTime ?? null,
        ccEmails:              body.ccEmails,
      }))
    })

    app.delete('/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      await routinesSvc.remove(id, req.user.sub)
      reply.status(204).send()
    })

    app.patch('/:id/activate', async (req, reply) => {
      const { id } = req.params as { id: string }
      reply.send(await routinesSvc.activate(id, req.user.sub))
    })

    app.patch('/:id/deactivate', async (req, reply) => {
      const { id } = req.params as { id: string }
      reply.send(await routinesSvc.deactivate(id, req.user.sub))
    })

    app.get('/admin/users/:userId', { preHandler: [app.requireAdmin] }, async (req, reply) => {
      const { userId } = req.params as { userId: string }
      reply.send(await routinesSvc.listByUser(userId))
    })

    app.post('/:id/dispatch', { preHandler: [app.requireAdmin] }, async (req, reply) => {
      const { id } = req.params as { id: string }
      await schedulerSvc.dispatchOne(id)
      reply.status(202).send({ message: 'Dispatch iniciado' })
    })
  }
}

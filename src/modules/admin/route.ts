import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { IAdminService } from './AdminService'

const requestIdParam = z.object({ requestId: z.string().uuid() })
const jobIdParam = z.object({ jobId: z.string().uuid() })
const routineIdParam = z.object({ routineId: z.string().uuid() })

export function adminRoute(adminSvc: IAdminService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    // Everything here is admin-only.
    app.addHook('preHandler', app.authenticate)
    app.addHook('preHandler', app.requireAdmin)

    // Snapshot of every job (state + running_since for live duration on the front).
    app.get('/jobs', async (_req, reply) => {
      reply.send({ jobs: await adminSvc.listJobs() })
    })

    app.get('/jobs/:requestId/events', async (req, reply) => {
      const { requestId } = requestIdParam.parse(req.params)
      reply.send({ events: await adminSvc.getJobEvents(requestId) })
    })

    app.get('/jobs/:jobId/timeline', async (req, reply) => {
      const { jobId } = jobIdParam.parse(req.params)
      reply.send({ events: await adminSvc.getJobTimeline(jobId) })
    })

    // Interrupt a job. The real confirmation arrives later via SSE (job.upsert).
    app.post('/jobs/:requestId/cancel', async (req, reply) => {
      const { requestId } = requestIdParam.parse(req.params)
      const result = await adminSvc.cancelJob(requestId, req.user.sub)
      reply.send(result)
    })

    // Resends the last e-mail of the routine — target alert or daily summary,
    // whichever went out last. The content is rebuilt from current data.
    app.post('/routines/:routineId/resend-last-notification', async (req, reply) => {
      const { routineId } = routineIdParam.parse(req.params)
      reply.send(await adminSvc.resendLastNotification(routineId))
    })

    // Clears the analysis history of the routine. Preserves what another routine
    // also sees and what is running — the response says what stayed.
    app.post('/routines/:routineId/reset-analyses', async (req, reply) => {
      const { routineId } = routineIdParam.parse(req.params)
      reply.send(await adminSvc.resetRoutineAnalyses(routineId))
    })
  }
}

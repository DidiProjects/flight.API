import { FastifyInstance } from 'fastify'
import { IUsersService } from './interfaces/IUsersService'
import {
  approveUserSchema,
  updateUserSchema,
  listUsersQuerySchema,
} from './schema'

export function usersRoute(usersSvc: IUsersService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.addHook('preHandler', app.authenticate)
    app.addHook('preHandler', app.requireAdmin)

    app.get('/', async (req, reply) => {
      const query = listUsersQuerySchema.parse(req.query)
      reply.send(await usersSvc.list(query.page, query.limit, query.status))
    })

    app.get('/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      reply.send(await usersSvc.getById(id))
    })

    app.patch('/:id/approve', async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = approveUserSchema.parse(req.body)
      await usersSvc.approve(id, body.role)
      reply.send({ message: 'Usuário aprovado.' })
    })

    app.patch('/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = updateUserSchema.parse(req.body)
      await usersSvc.update(id, body, req.user.sub)
      reply.send({ message: 'Usuário atualizado.' })
    })

    app.delete('/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      await usersSvc.remove(id, req.user.sub)
      reply.status(204).send()
    })
  }
}

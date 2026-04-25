import { FastifyInstance } from 'fastify'
import { IUsersService } from '../users/interfaces/IUsersService'
import { selfRegisterSchema } from '../users/schema'

export function registerRoute(usersSvc: IUsersService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.post('/', async (req, reply) => {
      const body = selfRegisterSchema.parse(req.body)
      await usersSvc.register(body.name, body.email)
      reply.status(201).send({ message: 'Cadastro recebido. Aguarde a aprovação do administrador.' })
    })
  }
}

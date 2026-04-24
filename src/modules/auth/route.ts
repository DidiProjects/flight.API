import { FastifyInstance } from 'fastify'
import { IAuthService } from './interfaces/IAuthService'
import {
  loginSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './schema'
import { env } from '../../config/env'

export function authRoute(authSvc: IAuthService) {
  return async function handler(app: FastifyInstance): Promise<void> {
    app.post('/login', async (req, reply) => {
      const body = loginSchema.parse(req.body)
      const user = await authSvc.login(body.email, body.password)

      const token = app.jwt.sign(
        { sub: user.id, role: user.role, email: user.email, mustChangePassword: user.must_change_password },
        { expiresIn: env.JWT_EXPIRES_IN },
      )

      reply.send({ token, mustChangePassword: user.must_change_password })
    })

    app.post(
      '/change-password',
      { preHandler: [app.authenticate] },
      async (req, reply) => {
        const body = changePasswordSchema.parse(req.body)
        await authSvc.changePassword(req.user.sub, body.currentPassword, body.newPassword)

        const token = app.jwt.sign(
          { sub: req.user.sub, role: req.user.role, email: req.user.email, mustChangePassword: false },
          { expiresIn: env.JWT_EXPIRES_IN },
        )
        reply.send({ token })
      },
    )

    app.post('/forgot-password', async (req, reply) => {
      const body = forgotPasswordSchema.parse(req.body)
      await authSvc.forgotPassword(body.email)
      reply.send({ message: 'Se o email existir, você receberá as instruções em breve.' })
    })

    app.post('/reset-password/:token', async (req, reply) => {
      const { token } = req.params as { token: string }
      const body = resetPasswordSchema.parse(req.body)
      await authSvc.resetPassword(token, body.password)
      reply.send({ message: 'Senha redefinida com sucesso.' })
    })
  }
}

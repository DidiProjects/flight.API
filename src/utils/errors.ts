import { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class BadRequestError extends ApiError {
  constructor(message = 'Bad request') {
    super(400, message)
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized') {
    super(401, message)
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden') {
    super(403, message)
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Not found') {
    super(404, message)
  }
}

export class ConflictError extends ApiError {
  constructor(message = 'Conflict') {
    super(409, message)
  }
}

export class UnprocessableError extends ApiError {
  constructor(message = 'Unprocessable entity') {
    super(422, message)
  }
}

export function errorHandler(
  error: FastifyError | ApiError | ZodError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const ctx = { method: req.method, url: req.url, reqId: req.id }

  if (error instanceof ZodError) {
    const issues = error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    reply.log.warn({ ...ctx, issues }, 'validation_error')
    reply.status(422).send({ error: 'Validation error', issues })
    return
  }

  if (error instanceof ApiError) {
    const level = error.statusCode >= 500 ? 'error' : 'warn'
    reply.log[level]({ ...ctx, statusCode: error.statusCode, message: error.message }, 'api_error')
    reply.status(error.statusCode).send({ error: error.message })
    return
  }

  const fastifyError = error as FastifyError
  if (fastifyError.statusCode) {
    const level = fastifyError.statusCode >= 500 ? 'error' : 'warn'
    reply.log[level]({ ...ctx, statusCode: fastifyError.statusCode, message: fastifyError.message }, 'fastify_error')
    reply.status(fastifyError.statusCode).send({ error: fastifyError.message })
    return
  }

  reply.log.error({ ...ctx, err: { message: error.message, stack: error.stack } }, 'unhandled_error')
  reply.status(500).send({ error: 'Internal server error' })
}

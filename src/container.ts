import { pool } from './db/pool'
import { env } from './config/env'

// Repositories
import { AuthRepository }             from './modules/auth/AuthRepository'
import { RefreshTokenRepository }     from './modules/auth/RefreshTokenRepository'
import { UsersRepository }            from './modules/users/UsersRepository'
import { AirlinesRepository }         from './modules/airlines/AirlinesRepository'
import { RoutinesRepository }         from './modules/routines/RoutinesRepository'
import { FlightOffersRepository }     from './modules/scrape/FlightOffersRepository'
import { BestFaresRepository }        from './modules/scrape/BestFaresRepository'
import { UnsubscribeTokensRepository } from './modules/unsubscribe/UnsubscribeTokensRepository'
import { NotificationLogRepository }  from './services/notifications/NotificationLogRepository'

// Services
import { EmailService }         from './services/email/EmailService'
import { NotificationsService } from './services/notifications/NotificationsService'
import { AuthService }          from './modules/auth/AuthService'
import { UsersService }         from './modules/users/UsersService'
import { AirlinesService }      from './modules/airlines/AirlinesService'
import { RoutinesService }      from './modules/routines/RoutinesService'
import { ScrapeService }        from './modules/scrape/ScrapeService'
import { UnsubscribeService }   from './modules/unsubscribe/UnsubscribeService'
import { SchedulerService }     from './services/scheduler/SchedulerService'

// ── Repositories ──────────────────────────────────────────────────────────────
const authRepo          = new AuthRepository(pool)
const refreshTokenRepo  = new RefreshTokenRepository(pool)
const usersRepo         = new UsersRepository(pool)
const airlinesRepo      = new AirlinesRepository(pool)
const routinesRepo      = new RoutinesRepository(pool)
const offersRepo        = new FlightOffersRepository(pool)
const bestFaresRepo     = new BestFaresRepository(pool)
const unsubTokensRepo   = new UnsubscribeTokensRepository(pool)
const notifLogRepo      = new NotificationLogRepository(pool)

// ── Services ──────────────────────────────────────────────────────────────────
const emailSvc = new EmailService(env)

const notifSvc = new NotificationsService(
  usersRepo,
  routinesRepo,
  bestFaresRepo,
  notifLogRepo,
  unsubTokensRepo,
  emailSvc,
  env,
)

const authSvc       = new AuthService(usersRepo, authRepo, refreshTokenRepo, emailSvc)
const usersSvc      = new UsersService(usersRepo, emailSvc)
const airlinesSvc   = new AirlinesService(airlinesRepo, routinesRepo)
const routinesSvc   = new RoutinesService(routinesRepo, airlinesRepo)
const scrapeSvc     = new ScrapeService(routinesRepo, offersRepo, bestFaresRepo, notifSvc)
const unsubSvc      = new UnsubscribeService(unsubTokensRepo, routinesRepo, pool)
const schedulerSvc  = new SchedulerService(routinesRepo, notifSvc, env)

export const container = {
  airlinesSvc,
  authSvc,
  usersSvc,
  routinesSvc,
  scrapeSvc,
  unsubSvc,
  schedulerSvc,
} as const

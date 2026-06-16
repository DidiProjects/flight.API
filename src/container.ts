import { pool } from './db/pool'
import { env } from './config/env'

// Repositories
import { AuthRepository }             from './modules/auth/AuthRepository'
import { RefreshTokenRepository }     from './modules/auth/RefreshTokenRepository'
import { UsersRepository }            from './modules/users/UsersRepository'
import { AirlinesRepository }         from './modules/airlines/AirlinesRepository'
import { RoutinesRepository }         from './modules/routines/RoutinesRepository'
import { UnsubscribeTokensRepository } from './modules/unsubscribe/UnsubscribeTokensRepository'
import { NotificationLogRepository }  from './services/notifications/NotificationLogRepository'
import { AirportsRepository }         from './modules/airports/AirportsRepository'
import { ScrapingJobRepository }      from './modules/scraping-jobs/ScrapingJobRepository'
import { FlightFaresRepository }      from './modules/flight-fares/FlightFaresRepository'

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
import { AirportsService }      from './modules/airports/AirportsService'
import { EvaluationService }    from './services/evaluation/EvaluationService'

// ── Repositories ──────────────────────────────────────────────────────────────
const authRepo         = new AuthRepository(pool)
const refreshTokenRepo = new RefreshTokenRepository(pool)
const usersRepo        = new UsersRepository(pool)
const airlinesRepo     = new AirlinesRepository(pool)
const routinesRepo     = new RoutinesRepository(pool)
const unsubTokensRepo  = new UnsubscribeTokensRepository(pool)
const notifLogRepo     = new NotificationLogRepository(pool)
const airportsRepo     = new AirportsRepository(pool)
const scrapingJobRepo  = new ScrapingJobRepository(pool)
const flightFaresRepo  = new FlightFaresRepository(pool)

// ── Services ──────────────────────────────────────────────────────────────────
const emailSvc = new EmailService(env)

const notifSvc = new NotificationsService(
  usersRepo,
  routinesRepo,
  flightFaresRepo,
  notifLogRepo,
  unsubTokensRepo,
  emailSvc,
  env,
)

const evaluationSvc = new EvaluationService(routinesRepo, flightFaresRepo, notifSvc)

const authSvc      = new AuthService(usersRepo, authRepo, refreshTokenRepo, emailSvc)
const usersSvc     = new UsersService(usersRepo, emailSvc)
const airlinesSvc  = new AirlinesService(airlinesRepo, routinesRepo)
const routinesSvc  = new RoutinesService(routinesRepo, airlinesRepo)
const scrapeSvc    = new ScrapeService(scrapingJobRepo, flightFaresRepo)
const unsubSvc     = new UnsubscribeService(unsubTokensRepo, routinesRepo, pool)
const schedulerSvc = new SchedulerService(scrapingJobRepo, flightFaresRepo, notifSvc, evaluationSvc, env)
const airportsSvc  = new AirportsService(airportsRepo, airlinesRepo)

export const container = {
  airlinesSvc,
  airportsSvc,
  authSvc,
  usersSvc,
  routinesSvc,
  scrapeSvc,
  unsubSvc,
  schedulerSvc,
  flightFaresRepo,
} as const

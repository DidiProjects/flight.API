import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EmailService } from './EmailService'
import type { Env } from '../../config/env'
import type { FlightAlertEmailParams, OfferBlock } from './interfaces/IEmailService'

const sendMail = vi.fn().mockResolvedValue(undefined)
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => sendMail(...a) }) },
}))

const env = {
  SMTP_HOST: 'smtp', SMTP_PORT: 587, SMTP_USER: 'u', SMTP_PASSWORD: 'p',
  SMTP_FROM: 'no-reply@x', FRONTEND_URL: 'http://localhost:3001',
} as unknown as Env

const leg = (over: Partial<OfferBlock> = {}): OfferBlock => ({
  flightNumber: 'BA247', currency: 'BRL', date: '2026-09-21',
  origin: 'GRU', departureTime: '15:30:00', destination: 'LHR', arrivalTime: '06:00:00',
  durationMin: 690, stops: 0, fareCash: 3280, ...over,
})

/** Sends the alert and returns the hrefs of the buy button. */
async function linksDoEmail(airline: string, ret: OfferBlock | null): Promise<string[]> {
  sendMail.mockClear()
  const params: FlightAlertEmailParams = {
    primaryEmail: 'a@b.c', primaryUnsubLink: 'http://unsub', ccRecipients: [],
    subject: 'alerta', routineName: 'rotina', origin: 'GRU', destination: 'LHR',
    passengers: 1, fareType: 'cash',
    airlineOffers: [{
      airline,
      outbound: leg(),
      return: ret,
      total: ret ? { amount: 6000, currency: 'BRL', converted: false, rateDate: null } : null,
    }],
  }
  await new EmailService(env).sendFlightAlert(params)
  const html = sendMail.mock.calls[0]![0].html as string
  return [...html.matchAll(/href="([^"]+)"/g)]
    .map(m => m[1]!)
    .filter(h => !h.includes('unsub'))
}

const volta = leg({ date: '2026-09-25', origin: 'LHR', destination: 'GRU', flightNumber: 'BA246' })

beforeEach(() => sendMail.mockClear())

describe('deep link de compra no e-mail — só-ida', () => {
  it('não inventa volta em nenhuma companhia', async () => {
    expect((await linksDoEmail('azul', null))[0]).not.toContain('c[1]')
    expect((await linksDoEmail('latam', null))[0]).toContain('trip=OW')
    expect((await linksDoEmail('britishairways', null))[0]).toContain('trip=oneWay')
    expect((await linksDoEmail('ryanair', null))[0]).toContain('isReturn=false')
  })
})

describe('deep link de compra no e-mail — ida-e-volta', () => {
  it('azul mantém a segunda perna que já tinha', async () => {
    const url = (await linksDoEmail('azul', volta))[0]!
    expect(url).toContain('c[1].ds=LHR')
    expect(url).toContain('c[1].std=09/25/2026')
  })

  it('ryanair pede as duas pernas na mesma busca', async () => {
    const p = new URL((await linksDoEmail('ryanair', volta))[0]!).searchParams
    expect(p.get('isReturn')).toBe('true')
    expect(p.get('dateIn')).toBe('2026-09-25')
    expect(p.get('tpEndDate')).toBe('2026-09-25')
  })

  it('BA vai para a UI velha, a única com fluxo de RT medido', async () => {
    const url = (await linksDoEmail('britishairways', volta))[0]!
    expect(url).toContain('/travel/book/public/en_gb/flightList')
    const p = new URL(url).searchParams
    expect(p.get('onds')).toBe('GRU-LHR_2026-09-21,LHR-GRU_2026-09-25')
    expect(p.get('ond')).toBe('2')
  })

  it('latam pede RT com a data de volta', async () => {
    const p = new URL((await linksDoEmail('latam', volta))[0]!).searchParams
    expect(p.get('trip')).toBe('RT')
    expect(p.get('inbound')).toBe('2026-09-25')
  })

  it('as duas pernas do e-mail apontam para o MESMO link do par', async () => {
    // The RETURN button gets the same `link` as the outbound: one pair, one search.
    const urls = await linksDoEmail('ryanair', volta)
    expect(urls.length).toBeGreaterThan(1)
    expect(new Set(urls).size).toBe(1)
  })
})

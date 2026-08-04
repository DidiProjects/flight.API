import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EmailService } from './EmailService'
import type { AirlineOfferPair, OfferBlock, FlightAlertEmailParams } from './interfaces/IEmailService'
import type { Env } from '../../config/env'

const sendMail = vi.fn().mockResolvedValue(undefined)
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => sendMail(...a) }) },
}))

const env = {
  SMTP_HOST: 'smtp', SMTP_PORT: 587, SMTP_USER: 'u', SMTP_PASSWORD: 'p',
  SMTP_FROM: 'no-reply@x', API_BASE_URL: 'http://api',
} as unknown as Env

function block(over: Partial<OfferBlock> = {}): OfferBlock {
  return {
    flightNumber: 'BA246', date: '2026-09-21',
    currency: 'BRL',
    origin: 'GRU', departureTime: '15:30', destination: 'LHR', arrivalTime: '06:50',
    durationMin: 680, stops: 0,
    fareCash: 4925, farePts: null, fareHybPts: null, fareHybCash: null,
    ...over,
  }
}

function params(offers: AirlineOfferPair[], fareType = 'cash'): FlightAlertEmailParams {
  return {
    primaryEmail: 'a@b.c', primaryUnsubLink: 'http://unsub', ccRecipients: [],
    subject: 'alerta', routineName: 'teste', origin: 'GRU', destination: 'LHR',
    airlineOffers: offers, passengers: 1, fareType,
  } as unknown as FlightAlertEmailParams
}

/** O HTML do primeiro e-mail enviado. */
const htmlEnviado = () => (sendMail.mock.calls[0]![0] as { html: string }).html

describe('EmailService — moeda por perna', () => {
  beforeEach(() => sendMail.mockClear())

  it('cada perna aparece na moeda DELA', async () => {
    // O caso Ryanair: a busca RT parte de Stansted e as duas pernas saem em
    // libra, mas a rotina avulsa da volta sai em euro. Antes o e-mail usava uma
    // moeda só para o par e rotulava uma das duas errado.
    await new EmailService(env).sendFlightAlert(params([{
      airline: 'ryanair',
      outbound: block({ currency: 'GBP', fareCash: 17.99, origin: 'STN', destination: 'DUB' }),
      return:   block({ currency: 'EUR', fareCash: 17.99, origin: 'DUB', destination: 'STN' }),
      total:    { amount: 245.5, currency: 'BRL', converted: true, rateDate: '2026-08-04' },
    }]))

    const html = htmlEnviado()
    expect(html).toContain('GBP')
    expect(html).toContain('EUR')
  })

  it('o total do par é o CONVERTIDO, não a soma das pernas', async () => {
    // £17,99 + €17,99 não é número. Quem soma é a avaliação, depois de
    // converter — aqui só se exibe.
    await new EmailService(env).sendFlightAlert(params([{
      airline: 'ryanair',
      outbound: block({ currency: 'GBP', fareCash: 17.99 }),
      return:   block({ currency: 'EUR', fareCash: 17.99 }),
      total:    { amount: 245.5, currency: 'BRL', converted: true, rateDate: '2026-08-04' },
    }]))

    const html = htmlEnviado()
    expect(html).toContain('245,50')
    // 35,98 seria a soma crua das duas pernas — o número que não existe.
    expect(html).not.toContain('35,98')
  })

  it('quando houve conversão, o e-mail diz a cotação usada', async () => {
    await new EmailService(env).sendFlightAlert(params([{
      airline: 'britishairways',
      outbound: block({ currency: 'GBP', fareCash: 730 }),
      return:   block({ currency: 'GBP', fareCash: 700 }),
      total:    { amount: 9724, currency: 'BRL', converted: true, rateDate: '2026-08-04' },
    }]))

    expect(htmlEnviado()).toContain('04/08/2026')
  })

  it('sem conversão, não polui o e-mail com nota de cotação', async () => {
    await new EmailService(env).sendFlightAlert(params([{
      airline: 'azul',
      outbound: block({ currency: 'BRL', fareCash: 400 }),
      return:   block({ currency: 'BRL', fareCash: 500 }),
      total:    { amount: 900, currency: 'BRL', converted: false, rateDate: null },
    }]))

    expect(htmlEnviado()).not.toContain('convertido')
  })

  it('sem total, o par não inventa linha de total', async () => {
    // É o caso do resumo agendado, que não passa pela avaliação e portanto não
    // tem número convertido. Melhor omitir do que somar moedas.
    await new EmailService(env).sendFlightAlert(params([{
      airline: 'ryanair',
      outbound: block({ currency: 'GBP', fareCash: 17.99 }),
      return:   block({ currency: 'EUR', fareCash: 17.99 }),
      total:    null,
    }]))

    expect(htmlEnviado()).not.toContain('TOTAL IDA + VOLTA')
  })

  it('pontos seguem somando: PTS não é moeda de câmbio', async () => {
    await new EmailService(env).sendFlightAlert(params([{
      airline: 'azul',
      outbound: block({ currency: 'BRL', fareCash: null, farePts: 10000 }),
      return:   block({ currency: 'BRL', fareCash: null, farePts: 15000 }),
      total:    null,
    }], 'pts'))

    expect(htmlEnviado()).toContain('25.000')
  })
})

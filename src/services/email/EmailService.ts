import nodemailer, { Transporter } from 'nodemailer'
import { Env } from '../../config/env'
import { IEmailService, FlightAlertEmailParams, DailyBestEmailParams, OfferBlock, AirlineOfferPair } from './interfaces/IEmailService'

export class EmailService implements IEmailService {
  private readonly transporter: Transporter

  constructor(private readonly env: Env) {
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    })
  }

  async sendFlightAlert(params: FlightAlertEmailParams): Promise<void> {
    const { primaryEmail, primaryUnsubLink, ccRecipients, subject } = params

    await this.transporter.sendMail({
      from: this.env.SMTP_FROM,
      to: primaryEmail,
      subject,
      html: this.buildAlertHtml(params, primaryUnsubLink),
    })

    for (const cc of ccRecipients) {
      await this.transporter.sendMail({
        from: this.env.SMTP_FROM,
        to: cc.email,
        subject: `[Cópia] ${subject}`,
        html: this.buildAlertHtml(params, cc.unsubLink),
      })
    }
  }

  async sendDailyBest(params: DailyBestEmailParams): Promise<void> {
    const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' })
    await this.transporter.sendMail({
      from: this.env.SMTP_FROM,
      to: params.primaryEmail,
      subject: `Resumo do dia ${today} — Monitoramento de Voos`,
      html: this.buildDailyBestHtml(params),
    })
  }

  async sendProvisionalPassword(email: string, password: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.env.SMTP_FROM,
      to: email,
      subject: 'Monitoramento de Voos — Sua senha provisória',
      html: this.wrapLayout(`
        <p>Sua conta foi criada. Use a senha abaixo para fazer login:</p>
        <div style="background:#f5f5f5;border-radius:4px;padding:16px;font-size:20px;font-family:monospace;text-align:center;letter-spacing:2px;">${password}</div>
        <p style="color:#888;font-size:13px;margin-top:16px;">Você precisará alterar sua senha no primeiro acesso. Esta senha expira em 24 horas.</p>
      `),
    })
  }

  async sendPasswordReset(email: string, token: string): Promise<void> {
    const resetLink = `${this.env.FRONTEND_URL}/reset-password?token=${token}`
    await this.transporter.sendMail({
      from: this.env.SMTP_FROM,
      to: email,
      subject: 'Monitoramento de Voos — Redefinição de senha',
      html: this.wrapLayout(`
        <p>Recebemos uma solicitação para redefinir a sua senha.</p>
        <p style="text-align:center;">
          <a href="${resetLink}" style="display:inline-block;background:#0066cc;color:white;padding:12px 24px;text-decoration:none;border-radius:4px;">Redefinir senha</a>
        </p>
        <p style="color:#888;font-size:13px;">Este link expira em 24 horas.</p>
        <p style="color:#aaa;font-size:12px;word-break:break-all;">${resetLink}</p>
      `),
    })
  }

  async sendUserApproved(email: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.env.SMTP_FROM,
      to: email,
      subject: 'Monitoramento de Voos — Conta aprovada',
      html: this.wrapLayout(`
        <p>Sua conta foi aprovada! Você já pode fazer login com a senha provisória recebida anteriormente.</p>
      `),
    })
  }

  // ---------------------------------------------------------------------------
  // Private template helpers
  // ---------------------------------------------------------------------------

  private buildDeepLink(offer: OfferBlock, airline: string, passengers: number, fareType: string, ret?: OfferBlock | null): string | null {
    switch (airline.toLowerCase()) {
      case 'azul':           return this.buildAzulLink(offer, passengers, fareType, ret)
      case 'latam':          return this.buildLatamLink(offer, passengers, fareType, ret)
      case 'britishairways': return this.buildBritishAirwaysLink(offer, passengers, ret)
      case 'ryanair':        return this.buildRyanairLink(offer, passengers, ret)
      default:               return null
    }
  }

  private buildAzulLink(offer: OfferBlock, passengers: number, fareType: string, ret?: OfferBlock | null): string {
    const cc = fareType === 'cash' ? 'BRL' : 'PTS'
    const azulDate = (iso: string) => {
      const [y, m, d] = iso.split('-')
      return `${m}/${d}/${y}`
    }
    const leg0 = `c[0].ds=${offer.origin}&c[0].std=${azulDate(offer.date)}&c[0].as=${offer.destination}`
    // Com volta, o link reproduz a MESMA busca ida-e-volta que originou o preço.
    const leg1 = ret
      ? `&c[1].ds=${ret.origin}&c[1].std=${azulDate(ret.date)}&c[1].as=${ret.destination}`
      : ''
    return `https://www.voeazul.com.br/br/pt/home/selecao-voo?${leg0}${leg1}&p[0].t=ADT&p[0].c=${passengers}&p[0].cp=false&f.dl=3&f.dr=3&cc=${cc}`
  }

  private buildLatamLink(offer: OfferBlock, passengers: number, fareType: string, ret?: OfferBlock | null): string {
    const redemption = fareType === 'cash' ? 'false' : 'true'
    // `trip=RT&inbound=<data>` conferido contra o site em 2026-08-05: a busca
    // abre com 35 cards e o cabeçalho "Escolha um voo de ida".
    const inbound = ret ? ret.date : 'undefined'
    const trip = ret ? 'RT' : 'OW'
    return `https://www.latamairlines.com/br/pt/oferta-voos?origin=${offer.origin}&outbound=${offer.date}&destination=${offer.destination}&inbound=${inbound}&adt=${passengers}&chd=0&inf=0&trip=${trip}&cabin=Economy&redemption=${redemption}&sort=RECOMMENDED`
  }

  /**
   * Só-ida vai para a UI nova; ida-e-volta, para a velha.
   *
   * O fluxo de ida-e-volta da BA só foi medido na UI velha (`flightList`, com
   * `onds` de duas pernas e `ond=2`) — é a que o scraper percorre quando a
   * origem é Brasil, e é de lá que sai todo par BA que dispara alerta hoje.
   * Montar `trip=return` na UI nova sem ter conferido o fluxo era o que já
   * fazia o link cair em só-ida.
   */
  private buildBritishAirwaysLink(offer: OfferBlock, passengers: number, ret?: OfferBlock | null): string {
    if (ret) {
      const p = new URLSearchParams({
        onds: `${offer.origin}-${offer.destination}_${offer.date},${ret.origin}-${ret.destination}_${ret.date}`,
        ad:    String(passengers),
        yad:  '0',
        ch:   '0',
        inf:  '0',
        cabin: 'M',
        flex:  'LOWEST',
        ond:  '2',
      })
      return `https://www.britishairways.com/travel/book/public/en_gb/flightList?${p.toString()}`
    }

    const p = new URLSearchParams({
      trip: 'oneWay',
      departureDate: offer.date,
      from: offer.origin,
      to: offer.destination,
      travelClass: 'economy',
      adults: String(passengers),
      youngAdults: '0',
      children: '0',
      infants: '0',
      bound: 'outbound',
    })
    return `https://www.britishairways.com/nx/b/airselect/en/gbr/book/search/?${p.toString()}`
  }

  /** Espelha o `buildSearchUrl` do scraper: os `tp*` acompanham a busca. */
  private buildRyanairLink(offer: OfferBlock, passengers: number, ret?: OfferBlock | null): string {
    const p = new URLSearchParams({
      adults:              String(passengers),
      teens:               '0',
      children:            '0',
      infants:             '0',
      dateOut:             offer.date,
      dateIn:              ret?.date ?? '',
      isConnectedFlight:   'false',
      discount:            '0',
      promoCode:           '',
      isReturn:            ret ? 'true' : 'false',
      originIata:          offer.origin,
      destinationIata:     offer.destination,
      tpAdults:            String(passengers),
      tpTeens:             '0',
      tpChildren:          '0',
      tpInfants:           '0',
      tpStartDate:         offer.date,
      tpEndDate:           ret?.date ?? '',
      tpDiscount:          '0',
      tpPromoCode:         '',
      tpOriginIata:        offer.origin,
      tpDestinationIata:   offer.destination,
    })
    return `https://www.ryanair.com/gb/en/trip/flights/select?${p.toString()}`
  }

  private buildAlertHtml(params: FlightAlertEmailParams, unsubLink: string): string {
    const { routineName, origin, destination, airlineOffers, passengers, fareType, historyNote } = params

    const offers = airlineOffers.map((ao: AirlineOfferPair) => {
      const airlineName = ao.airline.charAt(0).toUpperCase() + ao.airline.slice(1).toLowerCase()
      const link = this.buildDeepLink(ao.outbound, ao.airline, passengers, fareType, ao.return)
      return [
        this.renderOffer(ao.outbound, 'IDA',   link, airlineName, ao.outbound.currency),
        ao.return ? this.renderOffer(ao.return, 'VOLTA', link, airlineName, ao.return.currency) : '',
        ao.return ? this.renderPairTotal(ao, fareType) : '',
      ].join('')
    }).join('')

    const timestamp = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      dateStyle: 'short',
      timeStyle: 'short',
    })

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px 0;background:#f0f0f0;font-family:Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;">
          <tr>
            <td style="background:#1a1a2e;padding:20px 24px;border-radius:8px 8px 0 0;">
              <div style="color:#ffffff;font-size:16px;font-weight:bold;font-family:Arial,sans-serif;">Monitoramento de Voos</div>
              <div style="color:#8899bb;font-size:12px;margin-top:4px;font-family:Arial,sans-serif;">${routineName} · ${origin} → ${destination}</div>
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;padding:20px 24px;border-radius:0 0 8px 8px;font-family:Arial,sans-serif;">
              ${historyNote ? `<p style="margin:0 0 16px 0;font-size:13px;font-weight:600;color:#2D9B6B;">✓ ${historyNote}</p>` : ''}
              ${offers || '<p style="color:#555;margin:0;">Nenhuma oferta disponível neste período.</p>'}
            </td>
          </tr>
          <tr>
            <td style="padding:14px 24px;font-size:11px;color:#aaa;text-align:center;font-family:Arial,sans-serif;">
              Gerado em ${timestamp} (BRT) &nbsp;·&nbsp;
              <a href="${unsubLink}" style="color:#aaa;text-decoration:underline;">Cancelar recebimento</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
  }

  /**
   * Total da viagem no e-mail de RT. O alerta é avaliado contra a soma das duas
   * pernas — sem esta linha o usuário vê dois preços e nenhum deles é o número
   * que disparou a notificação.
   */
  private renderPairTotal(ao: AirlineOfferPair, fareType: string): string {
    const sum = (a: number | null | undefined, b: number | null | undefined) =>
      a == null || b == null ? null : Number(a) + Number(b)

    const out = ao.outbound
    const ret = ao.return
    if (!ret) return ''

    const rows: string[] = []
    const totalPts = sum(out.farePts, ret.farePts)

    if (fareType === 'cash') {
      // O total NÃO é somado aqui: em par de moedas diferentes, out.fareCash +
      // ret.fareCash daria libra somada com euro. Quem soma é a avaliação, que
      // converte antes — e é o número que disparou o alerta.
      if (ao.total == null) return ''
      const nota = ao.total.converted && ao.total.rateDate
        ? ` <span style="font-weight:400;color:#6b7280;">(convertido, cotação de ${ao.total.rateDate.split('-').reverse().join('/')})</span>`
        : ''
      rows.push(this.renderFareRow(
        `${ao.total.currency} total`,
        `${this.fmtCurrency(ao.total.amount, ao.total.currency)}${nota}`,
      ))
    } else if (fareType === 'pts' && totalPts != null) {
      // Pontos não convertem: somar é legítimo.
      rows.push(this.renderFareRow('Pontos total', `${totalPts.toLocaleString('pt-BR')} pts`))
    } else if (fareType === 'hyb') {
      const hybPts = sum(out.fareHybPts, ret.fareHybPts)
      if (hybPts != null && ao.total != null) {
        rows.push(this.renderFareRow(
          'Híbrido total',
          `${hybPts.toLocaleString('pt-BR')} pts + ${this.fmtCurrency(ao.total.amount, ao.total.currency)}`,
        ))
      }
    }
    if (rows.length === 0) return ''

    return `<tr><td style="padding:8px 20px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #041e42;">
        <tr><td style="padding-top:10px;font-size:13px;font-weight:700;color:#041e42;">TOTAL IDA + VOLTA</td></tr>
        ${rows.join('')}
      </table>
    </td></tr>`
  }

  private renderOffer(offer: OfferBlock, label: string, link: string | null, airline: string, currency: string): string {
    const dep   = offer.departureTime ? offer.departureTime.slice(0, 5) : '—'
    const arr   = offer.arrivalTime   ? offer.arrivalTime.slice(0, 5)   : '—'
    const dur   = `${Math.floor(offer.durationMin / 60)}h${String(offer.durationMin % 60).padStart(2, '0')}m`
    const stops = offer.stops === 0 ? 'Direto' : `${offer.stops} escala${offer.stops > 1 ? 's' : ''}`
    const date  = offer.date.split('-').reverse().join('/')

    const fareRows: string[] = []
    if (offer.fareCash != null)
      fareRows.push(this.renderFareRow(currency, this.fmtCurrency(offer.fareCash, currency)))
    if (offer.farePts != null)
      fareRows.push(this.renderFareRow('Pontos', `${offer.farePts.toLocaleString('pt-BR')} pts`))
    if (offer.fareHybPts != null && offer.fareHybCash != null)
      fareRows.push(this.renderFareRow('Híbrido', `${offer.fareHybPts.toLocaleString('pt-BR')} pts + ${this.fmtCurrency(offer.fareHybCash, currency)}`))

    return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
           style="border:1px solid #e8e8e8;border-radius:8px;margin-bottom:16px;">
      <tr>
        <td style="background:#f7f9fc;padding:10px 16px;border-bottom:1px solid #e8e8e8;border-radius:8px 8px 0 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;font-weight:bold;font-family:Arial,sans-serif;">${label} &nbsp;·&nbsp; ${date} &nbsp;·&nbsp; ${dep}</td>
              <td align="right" style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;font-weight:bold;font-family:Arial,sans-serif;">${airline}</td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:14px 16px 0 16px;font-family:Arial,sans-serif;">
          <div style="font-size:22px;font-weight:bold;color:#1a1a2e;letter-spacing:-0.5px;">${offer.origin} &nbsp;→&nbsp; ${offer.destination}</div>
          <div style="font-size:12px;color:#888;margin-top:4px;">${offer.flightNumber} &nbsp;·&nbsp; ${dep} – ${arr} &nbsp;·&nbsp; ${dur} &nbsp;·&nbsp; ${stops}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:14px 16px;font-family:Arial,sans-serif;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr><td style="border-top:1px solid #f0f0f0;padding-bottom:10px;"></td></tr>
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${fareRows.join('')}
          </table>
          ${link ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:14px;">
            <tr>
              <td align="center" bgcolor="#0055cc" style="border-radius:5px;">
                <a href="${link}" target="_blank"
                   style="display:block;padding:11px 0;font-size:13px;color:#ffffff;text-decoration:none;font-weight:bold;font-family:Arial,sans-serif;">
                  Ver em ${airline} ↗
                </a>
              </td>
            </tr>
          </table>` : ''}
        </td>
      </tr>
    </table>`
  }

  private renderFareRow(label: string, value: string): string {
    return `
    <tr>
      <td style="padding:5px 0;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-family:Arial,sans-serif;width:70px;">${label}</td>
      <td style="padding:5px 0;font-size:15px;font-weight:bold;color:#1a1a2e;font-family:Arial,sans-serif;" align="right">${value}</td>
    </tr>`
  }

  private buildDailyBestHtml(params: DailyBestEmailParams): string {
    const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' })
    const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })

    const sections = params.routines.map((section) => {
      const offers = section.airlineOffers.map((ao: AirlineOfferPair) => {
        const airlineName = ao.airline.charAt(0).toUpperCase() + ao.airline.slice(1).toLowerCase()
        const sectionLink = this.buildDeepLink(ao.outbound, ao.airline, section.passengers, section.fareType, ao.return)
        return [
          this.renderOffer(ao.outbound, 'IDA',   sectionLink, airlineName, ao.outbound.currency),
          ao.return ? this.renderOffer(ao.return, 'VOLTA', sectionLink, airlineName, ao.return.currency) : '',
          ao.return ? this.renderPairTotal(ao, section.fareType) : '',
        ].join('')
      }).join('')

      return `
      <tr>
        <td style="background:#1a1a2e;padding:14px 24px;">
          <div style="color:#ffffff;font-size:14px;font-weight:bold;font-family:Arial,sans-serif;">${section.routineName}</div>
          <div style="color:#8899bb;font-size:12px;margin-top:2px;font-family:Arial,sans-serif;">${section.origin} → ${section.destination} · ${section.passengers} passageiro${section.passengers > 1 ? 's' : ''}</div>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:20px 24px;font-family:Arial,sans-serif;">
          ${offers || '<p style="color:#555;margin:0;">Nenhuma oferta disponível neste período.</p>'}
          <div style="margin-top:4px;font-size:11px;text-align:right;">
            <a href="${section.unsubLink}" style="color:#ccc;text-decoration:underline;">Cancelar recebimento desta rotina</a>
          </div>
        </td>
      </tr>`
    }).join('')

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px 0;background:#f0f0f0;font-family:Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;">
          <tr>
            <td style="background:#0d0d1a;padding:20px 24px;border-radius:8px 8px 0 0;">
              <div style="color:#ffffff;font-size:16px;font-weight:bold;font-family:Arial,sans-serif;">Monitoramento de Voos</div>
              <div style="color:#8899bb;font-size:12px;margin-top:4px;font-family:Arial,sans-serif;">Resumo do dia — ${today}</div>
            </td>
          </tr>
          ${sections}
          <tr>
            <td style="padding:14px 24px;font-size:11px;color:#aaa;text-align:center;font-family:Arial,sans-serif;border-radius:0 0 8px 8px;">
              Gerado em ${timestamp} (BRT)
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
  }

  private wrapLayout(body: string): string {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px 0;background:#f0f0f0;font-family:Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;">
          <tr>
            <td style="background:#1a1a2e;color:#ffffff;padding:20px 24px;border-radius:8px 8px 0 0;font-family:Arial,sans-serif;">
              <span style="font-size:16px;font-weight:bold;">Monitoramento de Voos</span>
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;padding:24px;border-radius:0 0 8px 8px;font-family:Arial,sans-serif;">${body}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
  }

  private fmtCurrency(value: number, currency: string): string {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(value)
  }
}

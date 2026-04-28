import nodemailer, { Transporter } from 'nodemailer'
import { Env } from '../../config/env'
import { IEmailService, FlightAlertEmailParams, OfferBlock } from './interfaces/IEmailService'

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

  private buildDeepLink(offer: OfferBlock, airline: string, passengers: number, fareType: string): string | null {
    switch (airline.toLowerCase()) {
      case 'azul':  return this.buildAzulLink(offer, passengers, fareType)
      case 'latam': return this.buildLatamLink(offer, passengers, fareType)
      default:      return null
    }
  }

  private buildAzulLink(offer: OfferBlock, passengers: number, fareType: string): string {
    const cc = fareType === 'brl' ? 'BRL' : 'PTS'
    const [y, m, d] = offer.date.split('-')
    const std = `${m}/${d}/${y}`
    return `https://www.voeazul.com.br/br/pt/home/selecao-voo?c[0].ds=${offer.origin}&c[0].std=${std}&c[0].as=${offer.destination}&p[0].t=ADT&p[0].c=${passengers}&p[0].cp=false&f.dl=3&f.dr=3&cc=${cc}`
  }

  private buildLatamLink(offer: OfferBlock, passengers: number, fareType: string): string {
    const redemption = fareType === 'brl' ? 'false' : 'true'
    return `https://www.latamairlines.com/br/pt/oferta-voos?origin=${offer.origin}&outbound=${offer.date}&destination=${offer.destination}&inbound=undefined&adt=${passengers}&chd=0&inf=0&trip=OW&cabin=Economy&redemption=${redemption}&sort=RECOMMENDED`
  }

  private buildAlertHtml(params: FlightAlertEmailParams, unsubLink: string): string {
    const { routineName, origin, destination, outboundOffer, returnOffer, passengers, fareType, airline } = params
    const airlineName = airline.charAt(0).toUpperCase() + airline.slice(1).toLowerCase()

    const offers = [
      outboundOffer ? this.renderOffer(outboundOffer, 'IDA',   this.buildDeepLink(outboundOffer, airline, passengers, fareType), airlineName) : '',
      returnOffer   ? this.renderOffer(returnOffer,   'VOLTA', this.buildDeepLink(returnOffer,   airline, passengers, fareType), airlineName) : '',
    ].join('')

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

  private renderOffer(offer: OfferBlock, label: string, link: string | null, airline: string): string {
    const dep   = new Date(offer.departureTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    const arr   = new Date(offer.arrivalTime).toLocaleTimeString('pt-BR',   { hour: '2-digit', minute: '2-digit' })
    const dur   = `${Math.floor(offer.durationMin / 60)}h${String(offer.durationMin % 60).padStart(2, '0')}m`
    const stops = offer.stops === 0 ? 'Direto' : `${offer.stops} escala${offer.stops > 1 ? 's' : ''}`
    const date  = offer.date.split('-').reverse().join('/')

    const fareRows: string[] = []
    if (offer.fareBrl != null)
      fareRows.push(this.renderFareRow('BRL', this.fmtBrl(offer.fareBrl)))
    if (offer.farePts != null)
      fareRows.push(this.renderFareRow('Pontos', `${offer.farePts.toLocaleString('pt-BR')} pts`))
    if (offer.fareHybPts != null && offer.fareHybBrl != null)
      fareRows.push(this.renderFareRow('Híbrido', `${offer.fareHybPts.toLocaleString('pt-BR')} pts + ${this.fmtBrl(offer.fareHybBrl)}`))

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

  private fmtBrl(value: number): string {
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  }
}

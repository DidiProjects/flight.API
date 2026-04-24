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
      subject: 'flight.API — Sua senha provisória',
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
      subject: 'flight.API — Redefinição de senha',
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
      subject: 'flight.API — Conta aprovada',
      html: this.wrapLayout(`
        <p>Sua conta foi aprovada! Você já pode fazer login com a senha provisória recebida anteriormente.</p>
      `),
    })
  }

  // ---------------------------------------------------------------------------
  // Private template helpers
  // ---------------------------------------------------------------------------

  private buildAlertHtml(params: FlightAlertEmailParams, unsubLink: string): string {
    const { routineName, origin, destination, outboundOffer, returnOffer } = params
    const offers = [
      outboundOffer ? this.renderOffer(outboundOffer, 'Ida') : '',
      returnOffer   ? this.renderOffer(returnOffer,   'Volta') : '',
    ].join('')

    const timestamp = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      dateStyle: 'short',
      timeStyle: 'short',
    })

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;">
    <div style="background:#1a1a2e;color:white;padding:24px 30px;">
      <div style="font-size:20px;font-weight:bold;">flight.API</div>
      <div style="margin-top:6px;color:#aaa;font-size:14px;">${routineName} · ${origin} → ${destination}</div>
    </div>
    <div style="background:white;padding:30px;">
      ${offers || '<p style="color:#555;">Nenhuma oferta disponível neste período.</p>'}
    </div>
    <div style="background:#f5f5f5;padding:20px 30px;font-size:12px;color:#888;border-top:1px solid #e0e0e0;">
      <div>Gerado em ${timestamp} (BRT)</div>
      <div style="margin-top:8px;">
        <a href="${unsubLink}" style="color:#888;text-decoration:underline;">Cancelar recebimento deste email</a>
      </div>
    </div>
  </div>
</body>
</html>`
  }

  private renderOffer(offer: OfferBlock, label: string): string {
    const fares: string[] = []
    if (offer.fareBrl  != null) fares.push(`<strong>${this.fmtBrl(offer.fareBrl)}</strong>`)
    if (offer.farePts  != null) fares.push(`<strong>${offer.farePts.toLocaleString('pt-BR')} pts</strong>`)
    if (offer.fareHybPts != null && offer.fareHybBrl != null)
      fares.push(`<strong>${offer.fareHybPts.toLocaleString('pt-BR')} pts + ${this.fmtBrl(offer.fareHybBrl)}</strong>`)

    const dep  = new Date(offer.departureTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    const arr  = new Date(offer.arrivalTime).toLocaleTimeString('pt-BR',   { hour: '2-digit', minute: '2-digit' })
    const dur  = `${Math.floor(offer.durationMin / 60)}h${String(offer.durationMin % 60).padStart(2, '0')}m`
    const stops = offer.stops === 0 ? 'Direto' : `${offer.stops} escala${offer.stops > 1 ? 's' : ''}`
    const link  = `https://www.voeazul.com.br/pt-br/passagens-aereas?origin=${offer.origin}&destination=${offer.destination}&date=${offer.date}`

    return `
    <div style="border:1px solid #e0e0e0;border-radius:8px;padding:20px;margin-bottom:20px;">
      <div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">${label}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div>
          <div style="font-size:20px;font-weight:bold;color:#1a1a2e;">${dep} → ${arr}</div>
          <div style="color:#555;margin-top:4px;">${offer.origin} → ${offer.destination} · ${offer.flightNumber}</div>
          <div style="color:#888;font-size:13px;margin-top:4px;">${dur} · ${stops}</div>
        </div>
        <div style="text-align:right;">
          ${fares.map((f) => `<div style="font-size:18px;color:#0066cc;margin-bottom:4px;">${f}</div>`).join('')}
          <a href="${link}" style="display:inline-block;background:#0066cc;color:white;padding:8px 16px;text-decoration:none;border-radius:4px;font-size:13px;margin-top:8px;">Ver na Azul ↗</a>
        </div>
      </div>
    </div>`
  }

  private wrapLayout(body: string): string {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;">
    <div style="background:#1a1a2e;color:white;padding:24px 30px;">
      <div style="font-size:20px;font-weight:bold;">flight.API</div>
    </div>
    <div style="background:white;padding:30px;">${body}</div>
  </div>
</body>
</html>`
  }

  private fmtBrl(value: number): string {
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  }
}

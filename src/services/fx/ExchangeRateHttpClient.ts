import { logger } from '../../utils/logger'

const log = logger.child({ service: 'fx-http' })

/**
 * O ÚNICO ponto desta camada que abre socket.
 *
 * Concentrar aqui não é organização, é superfície de ataque: allowlist de host,
 * proibição de redirect e timeout ficam num lugar só, e um provedor novo não
 * consegue nascer sem eles nem por esquecimento.
 */
export class ExchangeRateHttpClient {
  /**
   * Hosts que esta camada pode acessar. Constante do código — nunca vem de
   * input, de banco ou de env editável por usuário.
   *
   * O par com `redirect: 'manual'` é o que fecha SSRF: sem ele, um provedor
   * comprometido responderia 302 para um host interno e a allowlist teria sido
   * checada só no primeiro salto.
   */
  private static readonly ALLOWED_HOSTS: ReadonlySet<string> = new Set([
    'api.frankfurter.dev',
    'cdn.jsdelivr.net',
  ])

  constructor(private readonly timeoutMs = 3_000) {}

  /** Erro de host recusado, separado para o teste conseguir afirmar o motivo. */
  static isAllowed(url: string): boolean {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    // HTTPS obrigatório: em texto claro a cotação pode ser trocada em trânsito,
    // e uma taxa adulterada vira decisão de alerta.
    if (parsed.protocol !== 'https:') return false
    return ExchangeRateHttpClient.ALLOWED_HOSTS.has(parsed.hostname)
  }

  /**
   * GET com timeout, sem redirect, devolvendo JSON não tipado.
   *
   * Não valida o corpo de propósito — quem conhece o formato é o provedor, e é
   * lá que o schema é conferido. Aqui só se garante que a resposta veio de onde
   * deveria e não travou o processo.
   */
  async getJson(url: string): Promise<unknown> {
    if (!ExchangeRateHttpClient.isAllowed(url)) {
      // Não loga a URL inteira: se ela algum dia vier de outro lugar, o log não
      // vira o veículo do valor não confiável.
      log.error({ host: safeHost(url) }, 'fx: host fora da allowlist recusado antes de abrir conexão')
      throw new Error('fx: host não permitido')
    }

    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    // 3xx com `redirect: 'manual'` chega aqui como resposta opaca. Seguir por
    // conta própria reabriria o buraco que a allowlist fecha.
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`fx: redirect recusado (${res.status})`)
    }
    if (!res.ok) {
      throw new Error(`fx: HTTP ${res.status}`)
    }
    return res.json()
  }
}

/** Só o host, para o log nunca carregar query string de origem duvidosa. */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return '<url inválida>'
  }
}

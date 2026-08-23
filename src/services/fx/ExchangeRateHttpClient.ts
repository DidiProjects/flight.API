import { logger } from '../../utils/logger'

const log = logger.child({ service: 'fx-http' })

/**
 * The ONLY point of this layer that opens a socket.
 *
 * Concentrating it here is not tidiness, it is attack surface: the host allowlist,
 * the redirect ban and the timeout live in one place, and a new provider cannot be
 * born without them, not even by oversight.
 */
export class ExchangeRateHttpClient {
  /**
   * Hosts this layer may reach. A code constant — never from input, from the bank,
   * or from a user-editable env.
   *
   * Pairing it with `redirect: 'manual'` is what closes SSRF: without that, a
   * compromised provider would answer 302 towards an internal host and the allowlist
   * would have been checked on the first hop only.
   */
  private static readonly ALLOWED_HOSTS: ReadonlySet<string> = new Set([
    'api.frankfurter.dev',
    'cdn.jsdelivr.net',
  ])

  constructor(private readonly timeoutMs = 3_000) {}

  /** Refused-host error, kept apart so the test can assert the reason. */
  static isAllowed(url: string): boolean {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    // HTTPS required: in clear text the quote can be swapped in transit, and a
    // tampered rate becomes an alert decision.
    if (parsed.protocol !== 'https:') return false
    return ExchangeRateHttpClient.ALLOWED_HOSTS.has(parsed.hostname)
  }

  /**
   * GET with a timeout, no redirect, returning untyped JSON.
   *
   * It deliberately does not validate the body — the provider knows the format, and
   * that is where the schema is checked. Here we only guarantee the response came
   * from where it should and did not hang the process.
   */
  async getJson(url: string): Promise<unknown> {
    if (!ExchangeRateHttpClient.isAllowed(url)) {
      // Does not log the whole URL: if it ever comes from elsewhere, the log does
      // not become the vehicle for the untrusted value.
      log.error({ host: safeHost(url) }, 'fx: host fora da allowlist recusado antes de abrir conexão')
      throw new Error('fx: host não permitido')
    }

    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    // A 3xx with `redirect: 'manual'` arrives here as an opaque response. Following
    // it ourselves would reopen the hole the allowlist closes.
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`fx: redirect recusado (${res.status})`)
    }
    if (!res.ok) {
      throw new Error(`fx: HTTP ${res.status}`)
    }
    return res.json()
  }
}

/** Host only, so the log never carries a query string of doubtful origin. */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return '<url inválida>'
  }
}

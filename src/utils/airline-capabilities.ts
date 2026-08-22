/**
 * What the routine asks for × what the airline can price.
 *
 * It exists because airline validation lived only in CREATION, and only for
 * `has_roundtrip`. Every other airline-dependent field — priority, targets, trip
 * type — was free on edit: it was enough to create the routine on an airline that
 * supports it and then SWAP the airline. That is how routines with a hybrid target
 * (20,000 pts + R$400) appeared on Ryanair, BA and LATAM, three airlines with
 * `has_hyb = false`, without anything complaining.
 *
 * So the rule lives here, pure and over the FINAL state: the caller assembles "how
 * the routine will look" and asks. That way create, update and adminUpdate ask the
 * same question, and a new path cannot be born without the validation.
 */

export interface AirlineCapabilities {
  code: string
  has_cash: boolean
  has_pts: boolean
  has_hyb: boolean
  has_roundtrip: boolean
}

/** The FINAL state of the routine — what it will be after creation or edit. */
export interface RoutinePricingState {
  tripType?: string | null
  priority?: string | null
  targetCash?: number | null
  targetPts?: number | null
  targetHybPts?: number | null
  targetHybCash?: number | null
}

type Dimension = 'cash' | 'pts' | 'hyb'

const DIMENSION_LABEL: Record<Dimension, string> = {
  cash: 'dinheiro',
  pts: 'pontos',
  hyb: 'híbrido (pontos + dinheiro)',
}

function supports(airline: AirlineCapabilities, dim: Dimension): boolean {
  return dim === 'cash' ? airline.has_cash : dim === 'pts' ? airline.has_pts : airline.has_hyb
}

/**
 * Compatibility error between the routine and its airlines, or `null`.
 *
 * Two rules with deliberately different demands:
 *
 * - **round-trip requires ALL of them**. A pair job dispatched to an airline with
 *   no RT search comes back with both legs loose and no total — false pair data,
 *   worse than no data (the reason for migration 008 in flight.DB).
 *
 * - **price dimension requires AT LEAST ONE**. On a [azul, latam] routine with
 *   priority on points, Azul alerts and LATAM simply does not contribute: nothing
 *   is corrupted. Only when NO airline prices that dimension does the routine
 *   become a promise it never keeps — and then blocking is the honest move.
 */
export function airlineCapabilityError(
  airlines: AirlineCapabilities[],
  routine: RoutinePricingState,
): string | null {
  if (airlines.length === 0) return null

  if (routine.tripType === 'round_trip') {
    const semRT = airlines.filter(a => !a.has_roundtrip).map(a => a.code)
    if (semRT.length > 0) {
      return `Companhia '${semRT[0]}' não suporta busca de ida e volta`
    }
  }

  const pedidas: Dimension[] = []
  if (routine.priority === 'pts' || routine.priority === 'hyb' || routine.priority === 'cash') {
    pedidas.push(routine.priority as Dimension)
  }
  if (routine.targetCash != null) pedidas.push('cash')
  if (routine.targetPts != null) pedidas.push('pts')
  if (routine.targetHybPts != null || routine.targetHybCash != null) pedidas.push('hyb')

  for (const dim of new Set(pedidas)) {
    if (airlines.some(a => supports(a, dim))) continue
    const nomes = airlines.map(a => `'${a.code}'`).join(', ')
    const alvo = dim === routine.priority ? 'prioridade' : 'alvo'
    return `Nenhuma companhia da rotina (${nomes}) precifica em ${DIMENSION_LABEL[dim]}: `
      + `${alvo} em ${DIMENSION_LABEL[dim]} nunca seria avaliado`
  }

  return null
}

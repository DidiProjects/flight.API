/**
 * O que a rotina pede × o que a companhia sabe precificar.
 *
 * Existe porque a validação de companhia estava só na CRIAÇÃO, e só para
 * `has_roundtrip`. Toda a classe de campo que depende da companhia — prioridade,
 * alvos, tipo de viagem — ficava livre na edição: bastava criar a rotina numa
 * companhia que suporta e depois TROCAR a companhia. Foi assim que apareceram
 * rotinas com alvo híbrido (20.000 pts + R$400) em Ryanair, BA e LATAM, três
 * companhias com `has_hyb = false`, sem que nada reclamasse.
 *
 * Por isso a regra mora aqui, pura e sobre o estado FINAL: quem chama monta o
 * "como a rotina vai ficar" e pergunta. Assim create, update e adminUpdate fazem
 * a mesma pergunta, e um caminho novo não nasce sem a validação.
 */

export interface AirlineCapabilities {
  code: string
  has_cash: boolean
  has_pts: boolean
  has_hyb: boolean
  has_roundtrip: boolean
}

/** O estado FINAL da rotina — o que ela será depois da criação ou da edição. */
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
 * Erro de compatibilidade entre a rotina e suas companhias, ou `null`.
 *
 * Duas regras com exigências propositalmente diferentes:
 *
 * - **ida-e-volta exige TODAS**. Um job de par despachado para companhia sem
 *   busca RT volta com as duas pernas avulsas e sem total — dado de par falso,
 *   pior que dado nenhum (é o motivo da migration 008 no flight.DB).
 *
 * - **dimensão de preço exige AO MENOS UMA**. Numa rotina [azul, latam] com
 *   prioridade em pontos, a Azul alerta e a LATAM simplesmente não contribui:
 *   nada corrompe. Só quando NENHUMA companhia precifica aquela dimensão é que
 *   a rotina vira promessa que nunca se cumpre — e aí barrar é o honesto.
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

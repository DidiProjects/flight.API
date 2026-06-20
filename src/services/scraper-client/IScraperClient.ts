export interface ScrapeDispatch {
  requestId: string
  routineId: string
  airline: string
  origin: string
  destination: string
  outboundStart: string
  outboundEnd: string
  passengers: number
}

export interface IScraperClient {
  dispatch(payload: ScrapeDispatch): Promise<void>
}

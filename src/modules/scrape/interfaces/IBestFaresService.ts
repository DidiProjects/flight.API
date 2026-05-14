export interface FareResult {
  amount:     number
  currency:   string
  date:       string
  updatedAt:  Date
  analysisId: string | null
  offer: {
    flightNumber:  string
    departureTime: string
    arrivalTime:   string
    durationMin:   number
    stops:         number
  }
}

export interface UserBestFaresResult {
  routineId:   string
  routineName: string
  origin:      string
  destination: string
  priority:    string
  isActive:    boolean
  outbound:    FareResult | null
  return:      FareResult | null
}

export interface IBestFaresService {
  adminGetUserBestFares(userId: string): Promise<UserBestFaresResult[]>
}

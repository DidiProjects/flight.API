export interface UnsubscribeResult {
  email: string
  routineName: string
  isPrimary: boolean
}

export interface IUnsubscribeService {
  process(token: string): Promise<UnsubscribeResult>
}

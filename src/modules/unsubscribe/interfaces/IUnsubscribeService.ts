export interface UnsubscribeResult {
  email: string
  routineName: string
  isPrimary: boolean
  /** The click changed nothing: the subscription was already cancelled. */
  alreadyUnsubscribed: boolean
}

export interface IUnsubscribeService {
  process(token: string): Promise<UnsubscribeResult>
}

export interface UserRow {
  id: string
  email: string
  name: string | null
  password_hash: string
  role: 'admin' | 'user'
  status: 'pending' | 'active' | 'suspended'
  must_change_password: boolean
  provisional_expires_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface AirlineRow {
  code: string
  name: string
  /** Moeda fixa da companhia (opcional). Quando definida, prevalece na resolução da moeda da rotina. */
  currency: string | null
  active: boolean
  has_cash: boolean
  has_pts: boolean
  has_hyb: boolean
}

export interface CcEmail {
  email: string
  subscribed: boolean
}

export interface RoutineRow {
  id: string
  user_id: string
  name: string
  airlines: string[]
  origin: string
  destination: string
  outbound_start: string
  outbound_end: string
  passengers: number
  currency: string | null
  target_cash: number | null
  target_pts: number | null
  target_hyb_pts: number | null
  target_hyb_cash: number | null
  margin: number
  priority: 'cash' | 'pts' | 'hyb'
  notification_modes: string[]
  notification_frequency: string
  scheduled_time: string | null
  cc_emails: CcEmail[]
  is_active: boolean
  created_at: Date
  updated_at: Date
}


export interface NotificationLogRow {
  id: string
  routine_id: string
  airline: string | null
  type: string
  fare_type: string
  outbound_amount: number | null
  return_amount: number | null
  email_to: string
  email_cc: string | null
  sent_at: Date
}

export interface UnsubscribeTokenRow {
  id: string
  token: string
  routine_id: string
  routine_name: string
  email: string
  is_primary: boolean
  expires_at: Date
  used_at: Date | null
  created_at: Date
}

export interface PasswordResetTokenRow {
  id: string
  user_id: string
  token: string
  expires_at: Date
  used_at: Date | null
  created_at: Date
}

export interface RefreshTokenRow {
  id: string
  user_id: string
  token: string
  expires_at: Date
  used_at: Date | null
  revoked_at: Date | null
  created_at: Date
}

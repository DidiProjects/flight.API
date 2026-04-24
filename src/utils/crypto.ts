import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'crypto'

const ITERATIONS = 100_000
const KEYLEN = 64
const DIGEST = 'sha512'

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const derived = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST).toString('hex')
  return timingSafeEqual(Buffer.from(derived), Buffer.from(hash))
}

export function generateToken(bytes = 64): string {
  return randomBytes(bytes).toString('hex')
}

export function generateProvisionalPassword(): string {
  return randomBytes(10).toString('base64url')
}

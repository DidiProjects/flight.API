import { randomBytes } from 'crypto'
import { hashSync, compareSync } from 'bcryptjs'

const SALT_ROUNDS = 12

export function hashPassword(password: string): string {
  return hashSync(password, SALT_ROUNDS)
}

export function verifyPassword(password: string, stored: string): boolean {
  return compareSync(password, stored)
}

export function generateToken(bytes = 64): string {
  return randomBytes(bytes).toString('hex')
}

export function generateProvisionalPassword(): string {
  return randomBytes(10).toString('base64url')
}

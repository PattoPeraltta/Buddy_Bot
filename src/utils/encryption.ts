/// <reference types="node" />
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto'

const ALGORITHM = 'aes-256-cbc'
const IV_LENGTH = 16 // 16 bytes for AES

function getKey(secret: string): Buffer {
    // Hash the secret to ensure 32-byte key length for AES-256
    return createHash('sha256').update(secret).digest()
}

export function encrypt(text: string, secret: string): string {
    const iv = randomBytes(IV_LENGTH)
    const key = getKey(secret)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    // Store iv and encrypted text joined by ':'
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`
}

export function decrypt(data: string, secret: string): string {
    const [ivHex, encryptedHex] = data.split(':')
    if (!ivHex || !encryptedHex) throw new Error('Invalid encrypted data format')
    const iv = Buffer.from(ivHex, 'hex')
    const encrypted = Buffer.from(encryptedHex, 'hex')
    const key = getKey(secret)
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
    return decrypted.toString('utf8')
} 
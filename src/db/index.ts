import { JSONSyncPreset } from 'lowdb/node'
import { encrypt, decrypt } from '../utils/encryption.js'
import { config } from '../config/index.js'

interface UserRecord {
    phone: string
    tokenEnc: string
    vercelTokenEnc?: string  // Optional Vercel token
    createdAt: string
    activeRepoId: number | null
}

interface RepoRecord {
    id: number
    phone: string
    repoUrl: string
    localPath: string
    createdAt: string
}

interface DataSchema {
    users: UserRecord[]
    repos: RepoRecord[]
    nextRepoId: number
}

const defaultData: DataSchema = { users: [], repos: [], nextRepoId: 1 }
const db = JSONSyncPreset<DataSchema>(config.db.file, defaultData)

function write() {
    db.write()
}

export function saveToken(phone: string, token: string) {
    console.log('💾 Saving token for phone:', phone, 'Token length:', token.length)
    const tokenEnc = encrypt(token, config.db.encryptionSecret)
    console.log('🔒 Token encrypted, length:', tokenEnc.length)
    const existing = db.data!.users.find((u) => u.phone === phone)
    if (existing) {
        existing.tokenEnc = tokenEnc
        console.log('📝 Updated existing user token')
    } else {
        db.data!.users.push({ phone, tokenEnc, createdAt: new Date().toISOString(), activeRepoId: null })
        console.log('👤 Created new user with token')
    }
    write()
    console.log('💾 Token save completed')
}

export function getToken(phone: string): string | null {
    console.log('🔍 Retrieving token for phone:', phone)
    const record = db.data!.users.find((u) => u.phone === phone)
    if (!record) {
        console.log('❌ No user record found')
        return null
    }
    console.log('👤 User record found, encrypted token length:', record.tokenEnc.length)
    try {
        const decryptedToken = decrypt(record.tokenEnc, config.db.encryptionSecret)
        console.log('🔓 Token decrypted successfully, length:', decryptedToken.length)
        return decryptedToken
    } catch {
        console.log('❌ Failed to decrypt token')
        return null
    }
}

export function addRepo(phone: string, repoUrl: string, localPath: string) {
    const id = db.data!.nextRepoId++
    db.data!.repos.push({ id, phone, repoUrl, localPath, createdAt: new Date().toISOString() })
    setActiveRepo(phone, id)
    write()
}

export function listRepos(phone: string): RepoRecord[] {
    return db.data!.repos.filter((r) => r.phone === phone)
}

export function setActiveRepo(phone: string, repoId: number) {
    const user = db.data!.users.find((u) => u.phone === phone)
    if (user) {
        user.activeRepoId = repoId
    }
    write()
}

export function getActiveRepo(phone: string): RepoRecord | null {
    const user = db.data!.users.find((u) => u.phone === phone)
    if (!user || user.activeRepoId == null) return null
    return db.data!.repos.find((r) => r.id === user.activeRepoId) || null
}

export function saveVercelToken(phone: string, token: string) {
    console.log('💾 Saving Vercel token for phone:', phone, 'Token length:', token.length)
    const tokenEnc = encrypt(token, config.db.encryptionSecret)
    console.log('🔒 Vercel token encrypted, length:', tokenEnc.length)
    const existing = db.data!.users.find((u) => u.phone === phone)
    if (existing) {
        existing.vercelTokenEnc = tokenEnc
        console.log('📝 Updated existing user Vercel token')
    } else {
        db.data!.users.push({ 
            phone, 
            tokenEnc: '', 
            vercelTokenEnc: tokenEnc, 
            createdAt: new Date().toISOString(), 
            activeRepoId: null 
        })
        console.log('👤 Created new user with Vercel token')
    }
    write()
    console.log('💾 Vercel token save completed')
}

export function getVercelToken(phone: string): string | null {
    console.log('🔍 Retrieving Vercel token for phone:', phone)
    const record = db.data!.users.find((u) => u.phone === phone)
    if (!record || !record.vercelTokenEnc) {
        console.log('❌ No Vercel token found')
        return null
    }
    console.log('👤 User record found, encrypted Vercel token length:', record.vercelTokenEnc.length)
    try {
        const decryptedToken = decrypt(record.vercelTokenEnc, config.db.encryptionSecret)
        console.log('🔓 Vercel token decrypted successfully, length:', decryptedToken.length)
        return decryptedToken
    } catch {
        console.log('❌ Failed to decrypt Vercel token')
        return null
    }
} 
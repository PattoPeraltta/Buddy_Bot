import { Browsers } from 'baileys'

export const config = {
    // Session
    session: {
        sessionPath: process.env.SESSION_PATH || './auth_info_baileys'
    },

    // Baileys
    baileys: {
        browser: Browsers.macOS('Chrome'),
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        keepAliveIntervalMs: 60000,
        qrTimeout: 40000
    },

    // Server
    server: {
        port: parseInt(process.env.PORT || '8081')
    },

    // Bot
    bot: {
        name: process.env.BOT_NAME || 'HackTheChat',
        aiEnabled: process.env.AI_ENABLED === 'true'
    },

    // OpenAI
    ai: {
        apiKey: process.env.OPENAI_API_KEY || '',
        systemPrompt: process.env.AI_SYSTEM_PROMPT || ''
    },

    // Logging
    logs: {
        level: process.env.LOG_LEVEL || 'info',
        colorize: true,
        timestamp: true
    },

    // Security / Access
    allowedPhones: (process.env.ALLOWED_PHONES || '5491132986313')
        .split(',')
        .map((p) => p.replace(/\D/g, '')),

    // Database
    db: {
        file: process.env.DB_FILE || 'db.json',
        encryptionSecret: process.env.ENCRYPTION_SECRET || 'please_change_me'
    },

    // Replicate API
    replicateApiKey: process.env.REPLICATE_API_KEY || ''
}

export type Config = typeof config

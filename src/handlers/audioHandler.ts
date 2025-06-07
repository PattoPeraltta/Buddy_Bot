import { WASocket, downloadMediaMessage, proto } from 'baileys'
import { createLogger } from '../logger/index.js'
import { saveAudioBuffer, convertToWav, cleanupAudioFiles } from '../utils/audioUtils.js'
import { transcribeAudio } from '../ai/whisper.js'
import { analyzeAudioIntent, chatWithRepoFunctions } from '../ai/openai.js'
import { conversationHistory, githubReposCache, addToHistory, processTextMessage } from './messageHandler.js'
import { config } from '../config/index.js'

const logger = createLogger('AudioHandler')

function normalizePhone(jid: string): string {
    return jid.replace(/[^0-9]/g, '')
}

export async function handleAudioMessage(sock: WASocket, message: proto.IWebMessageInfo) {
    try {
        const remoteJid = message.key.remoteJid
        if (!remoteJid) return

        // Check if message has audio (handles both audio and voice notes)
        const audioMessage = message.message?.audioMessage
        if (!audioMessage) return

        // Add phone number verification for audio messages too
        const senderJid = message.key.participant || remoteJid
        const phone = normalizePhone(senderJid.split('@')[0])
        logger.info('Audio phone check', { senderJid, phone, allowedPhones: config.allowedPhones })
        if (!config.allowedPhones.includes(phone)) {
            logger.info('Phone not allowed for audio, ignoring message', { phone })
            return
        }
        logger.info('Phone allowed for audio, processing message', { phone })

        logger.info('Processing audio message', { 
            from: remoteJid,
            messageId: message.key.id,
            type: message.message?.audioMessage ? 'audio' : 'voice'
        })

        // Send processing message
        await sock.sendMessage(remoteJid, { 
            text: '🎵 Processing your audio message...' 
        })

        // Download the audio
        const buffer = await downloadMediaMessage(
            message,
            'buffer',
            {}
        )

        if (!Buffer.isBuffer(buffer)) {
            throw new Error('Failed to download audio')
        }

        // Save and convert audio
        const originalFilename = `${message.key.id}.ogg`
        const tempPath = await saveAudioBuffer(buffer, originalFilename)
        const wavPath = await convertToWav(tempPath)

        try {
            // Transcribe audio using the local file path
            const transcription = await transcribeAudio(wavPath)
            logger.info('Audio transcribed', { transcription })

            // Show transcription to user for transparency  
            await sock.sendMessage(remoteJid, { 
                text: `Got it: "${transcription}"\n\nLet me see what you need...` 
            })

            // Analyze intent using AI
            const cachedGithubRepos = githubReposCache[remoteJid] || []
            const intent = await analyzeAudioIntent(transcription, cachedGithubRepos)
            logger.info('Audio intent analyzed', { intent })

            // Route based on detected intent
            if (intent.intent === 'command' && intent.extractedCommand) {
                // Special handling for clone requests with fuzzy search
                if (intent.extractedCommand.toLowerCase().includes('clone') && intent.suggestedRepo) {
                    const buddyMessages = [
                        `Found it! Let me clone ${intent.suggestedRepo.name} for you.`,
                        `Ah, you want ${intent.suggestedRepo.name}! On it.`,
                        `Got you covered - cloning ${intent.suggestedRepo.name} now.`,
                        `Perfect! I know exactly which one you mean - ${intent.suggestedRepo.name}.`
                    ]
                    const randomMessage = buddyMessages[Math.floor(Math.random() * buddyMessages.length)]
                    
                    await sock.sendMessage(remoteJid, { text: randomMessage })
                    addToHistory(remoteJid, 'assistant', randomMessage)
                    
                    // Clone the suggested repo directly
                    await processTextMessage(sock, remoteJid, `clone ${intent.suggestedRepo.name}`, true)
                } else if (intent.extractedCommand.toLowerCase().includes('clone')) {
                    // Clone request but no repo found
                    const helpfulMessages = [
                        `I'd love to help you clone a repo! But I need to know which one.`,
                        `Sure thing! Which repository do you want me to clone?`,
                        `Ready to clone! Just tell me the specific repo name.`,
                        `I can definitely clone a repo for you. Which one are you thinking of?`
                    ]
                    const randomHelpMessage = helpfulMessages[Math.floor(Math.random() * helpfulMessages.length)]
                    
                    if (cachedGithubRepos.length > 0) {
                        const topRepos = cachedGithubRepos.slice(0, 5).map(repo => repo.name).join(', ')
                        await sock.sendMessage(remoteJid, { 
                            text: `${randomHelpMessage}\n\nYour recent repos: ${topRepos}\n\nJust say "clone [repo-name]"!` 
                        })
                    } else {
                        await sock.sendMessage(remoteJid, { 
                            text: `${randomHelpMessage}\n\nTry saying "/repos" first to load your repositories!` 
                        })
                    }
                    addToHistory(remoteJid, 'assistant', randomHelpMessage)
                } else {
                    // Other commands
                    await processTextMessage(sock, remoteJid, intent.extractedCommand, true)
                }
            } else if (intent.intent === 'vibe' && intent.vibePrompt) {
                // Handle as a /vibe command using shared function
                await processTextMessage(sock, remoteJid, `/vibe ${intent.vibePrompt}`, true)
            } else {
                // Handle as general conversation
                addToHistory(remoteJid, 'user', transcription)
                const history = conversationHistory[remoteJid] || []
                
                const response = await chatWithRepoFunctions(remoteJid, transcription, history, cachedGithubRepos)
                
                await sock.sendMessage(remoteJid, { 
                    text: response 
                })
                addToHistory(remoteJid, 'assistant', response)
            }

        } finally {
            // Cleanup temporary files
            await cleanupAudioFiles(tempPath)
            await cleanupAudioFiles(wavPath)
        }

    } catch (error) {
        logger.error('Error handling audio message', { error })
        const remoteJid = message.key.remoteJid
        if (remoteJid) {
            await sock.sendMessage(remoteJid, { 
                text: '❌ Sorry, I had trouble processing your audio message. Please try again.' 
            })
        }
    }
} 
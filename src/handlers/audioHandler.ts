import { WASocket, downloadMediaMessage, proto } from 'baileys'
import { createLogger } from '../logger/index.js'
import { saveAudioBuffer, convertToWav, cleanupAudioFiles } from '../utils/audioUtils.js'
import { transcribeAudio } from '../ai/whisper.js'
import { generateResponse } from '../ai/openai.js'

const logger = createLogger('AudioHandler')

export async function handleAudioMessage(sock: WASocket, message: proto.IWebMessageInfo) {
    try {
        const remoteJid = message.key.remoteJid
        if (!remoteJid) return

        // Check if message has audio (handles both audio and voice notes)
        const audioMessage = message.message?.audioMessage
        if (!audioMessage) return

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

            // Generate response using OpenAI
            const response = await generateResponse(transcription)
            
            // Send only the AI response (hide transcription for cleaner conversation)
            await sock.sendMessage(remoteJid, { 
                text: response 
            })

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
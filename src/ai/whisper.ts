import Replicate from 'replicate'
import { createLogger } from '../logger/index.js'
import { config } from '../config/index.js'
import { readFile } from 'node:fs/promises'

const logger = createLogger('WhisperService')

const replicate = new Replicate({
    auth: config.replicateApiKey,
})

export async function transcribeAudio(audioPath: string): Promise<string> {
    try {
        logger.info('Starting audio transcription', { 
            audioPath,
            apiKeyExists: !!config.replicateApiKey 
        })
        
        // Read the audio file into a buffer and convert to base64 data URI
        const audioBuffer = await readFile(audioPath);
        const base64Audio = audioBuffer.toString('base64');
        const dataUri = `data:audio/wav;base64,${base64Audio}`;

        const output = await replicate.run(
            "vaibhavs10/incredibly-fast-whisper:3ab86df6c8f54c11309d4d1f930ac292bad43ace52d10c80d87eb258b3c9f79c",
            {
                input: {
                    audio: dataUri,
                    batch_size: 64
                }
            }
        )

        logger.info('Transcription completed', { output })
        
        // The output is an object with a 'text' property containing the transcription
        if (typeof output === 'object' && output !== null && 'text' in output) {
            return (output as { text: string }).text;
        }
        
        // Fallback for unexpected output format
        return Array.isArray(output) ? output.join(' ') : String(output)
    } catch (error) {
        logger.error('Error transcribing audio. Full error object:', { 
            error: JSON.stringify(error, Object.getOwnPropertyNames(error))
        })
        throw new Error('Failed to transcribe audio')
    }
} 
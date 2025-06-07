import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import ffmpeg from 'fluent-ffmpeg'
import { createLogger } from '../logger/index.js'
import { config } from '../config/index.js'

const logger = createLogger('AudioUtils')

// Ensure temp directory exists
const TEMP_DIR = path.join(process.cwd(), 'temp', 'audio')
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true })
}

export async function saveAudioBuffer(buffer: Buffer, originalFilename: string): Promise<string> {
    const fileId = uuidv4()
    const tempPath = path.join(TEMP_DIR, `${fileId}_${originalFilename}`)
    
    await fs.promises.writeFile(tempPath, buffer)
    logger.info('Audio saved to temp file', { tempPath })
    
    return tempPath
}

export async function convertToWav(inputPath: string): Promise<string> {
    const outputPath = inputPath.replace(/\.[^/.]+$/, '.wav')
    
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .toFormat('wav')
            .audioChannels(1)
            .audioFrequency(16000)
            .on('end', () => {
                logger.info('Audio converted to WAV', { outputPath })
                resolve(outputPath)
            })
            .on('error', (err) => {
                logger.error('Error converting audio', { error: err.message })
                reject(err)
            })
            .save(outputPath)
    })
}

export async function cleanupAudioFiles(filePath: string) {
    try {
        await fs.promises.unlink(filePath)
        logger.info('Temporary audio file cleaned up', { filePath })
    } catch (error) {
        logger.error('Error cleaning up audio file', { error, filePath })
    }
} 
import { BaileysEventMap, WASocket, WAMessage } from 'baileys'

import { config } from '../config/index.js'
import { generateResponse } from '../ai/openai.js'
import { createLogger } from '../logger/index.js'

import simpleGit from 'simple-git'
import { exec } from 'child_process'

const logger = createLogger('MessageHandler')
const userState = {}

export function setupMessageHandler(sock: WASocket) {
    // Handle incoming messages
    sock.ev.on(
        'messages.upsert',
        async ({ messages, type }: BaileysEventMap['messages.upsert']) => {
            // Only process new messages
            if (type !== 'notify') return

            for (const message of messages) {
                // Skip if no message content
                if (!message.message) continue

                // Skip messages from self
                if (message.key.fromMe) continue

                await handleMessage(sock, message)
            }
        }
    )
}

async function handleMessage(sock: WASocket, message: WAMessage) {
    try {
        const remoteJid = message.key.remoteJid
        if (!remoteJid) return

        const textContent =
            message.message?.conversation || message.message?.extendedTextMessage?.text || ''

        if (!textContent) return

        logger.info('Message received', {
            from: remoteJid,
            text: textContent,
            messageId: message.key.id
        })

        // 1. Clone flow
        if (textContent.startsWith('/clone ')) {
            const repoUrl = textContent.split(' ')[1]
            const repoId = Date.now()
            const localPath = `./repos/${repoId}`

            // Clone
            simpleGit().clone(repoUrl, localPath)
                .then(async () => {
                    // Index with janito
                    exec(`cd ${localPath} && janito describe`, async (err, stdout, stderr) => {
                        if (err) {
                            await sock.sendMessage(remoteJid, { text: `Repo cloned but failed to describe repo: ${stderr || err}` })
                        } else {
                            userState[remoteJid] = { repoPath: localPath, waitingForEdit: true }
                            // Build the rich message
                            const janitoDesc = stdout && stdout.trim().length > 0
                                ? stdout.trim().substring(0, 2500) // Optional: limit length for WhatsApp
                                : "(No description provided by Janito)"
                            await sock.sendMessage(remoteJid, {
                                text: `Repo cloned!\n\n${janitoDesc}\n\nWhat do you want to change? Please describe the change.`
                            })
                        }
                    })
                })
                .catch(async (err) =>
                    await sock.sendMessage(remoteJid, { text: `Failed to clone: ${err}` })
                )
            return
        }

        // 2. If waiting for edit instruction
        if (userState[remoteJid]?.waitingForEdit) {
            const repoPath = userState[remoteJid].repoPath
            const janitoCmd = `cd ${repoPath} && janito describe`

            // Notify user
            await sock.sendMessage(remoteJid, { text: "Applying changes with AI. Please wait..." })

            exec(janitoCmd, async (err, stdout, stderr) => {
                if (err) {
                    await sock.sendMessage(remoteJid, { text: `Error applying changes: ${stderr || err}` })
                } else {
                    // After change, update state
                    userState[remoteJid].waitingForEdit = false
                    userState[remoteJid].waitingForCommit = true
                    await sock.sendMessage(remoteJid, {
                        text: "Changes done! Do you want me to commit? (yes/no)"
                    })
                }
            })
            return
        }

        // 3. If waiting for commit confirmation
        if (userState[remoteJid]?.waitingForCommit) {
            if (/^(yes|commit)/i.test(textContent.trim())) {
                const repoPath = userState[remoteJid].repoPath
                const git = simpleGit(repoPath)
                await git.add('.')
                await git.commit('Applied AI code changes')
                // Optional: push here
                userState[remoteJid].waitingForCommit = false
                await sock.sendMessage(remoteJid, { text: "Committed! (You can now /deploy or /edit again.)" })
            } else {
                userState[remoteJid].waitingForCommit = false
                await sock.sendMessage(remoteJid, { text: "Changes not committed. You can send another instruction or /commit later." })
            }
            return
        }

        // Your AI fallback logic here, or echo:
        if (config.bot.aiEnabled) {
            // ... (existing AI fallback)
        } else {
            await sock.sendMessage(remoteJid, { text: `Echo: ${textContent}` })
        }
    } catch (error) {
        logger.error('Error handling message', error, {
            messageId: message.key.id,
            from: message.key.remoteJid
        })
    }
}

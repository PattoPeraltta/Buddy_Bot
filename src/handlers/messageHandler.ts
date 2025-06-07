import { BaileysEventMap, WASocket, WAMessage } from 'baileys'
import { config } from '../config/index.js'
import { generateResponse } from '../ai/openai.js'
import { createLogger } from '../logger/index.js'
import simpleGit from 'simple-git'
import { exec } from 'child_process'

const logger = createLogger('MessageHandler')
const userState = {}

// List of allowed phone numbers
const ALLOWED_NUMBERS = [  
    '5493764177993'   // +54 9 3764 17-7993
]

export function setupMessageHandler(sock: WASocket) {
    sock.ev.on(
        'messages.upsert',
        async ({ messages, type }: BaileysEventMap['messages.upsert']) => {
            if (type !== 'notify') return
            for (const message of messages) {
                if (!message.message) continue
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

        // Extract phone number from remoteJid (remove @s.whatsapp.net)
        const phoneNumber = remoteJid.split('@')[0]
        
        // Check if the number is allowed
        if (!ALLOWED_NUMBERS.includes(phoneNumber)) {
            logger.info('Message received from unauthorized number', {
                from: remoteJid,
                messageId: message.key.id
            })
            return
        }

        const textContent =
            message.message?.conversation || message.message?.extendedTextMessage?.text || ''

        if (!textContent) return

        logger.info('Message received', {
            from: remoteJid,
            text: textContent,
            messageId: message.key.id
        })

        // CLONE
        if (textContent.startsWith('/clone ')) {
            const repoUrl = textContent.split(' ')[1]
            const repoId = Date.now()
            const localPath = `./repos/${repoId}`
            logger.info(`Cloning repo ${repoUrl} to ${localPath}`)

            simpleGit().clone(repoUrl, localPath)
                .then(async () => {
                    logger.info('Clone successful', { repoUrl, localPath })
                    exec(`cd ${localPath} && janito describe`, async (err, stdout, stderr) => {
                        logger.info('Janito describe after clone', { err, stdout, stderr })
                        if (err) {
                            await sock.sendMessage(remoteJid, { text: `Repo cloned but failed to describe repo.\n\nERR:\n${err}\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}` })
                        } else {
                            userState[remoteJid] = { repoPath: localPath, waitingForEdit: true }
                            const janitoDesc = stdout && stdout.trim().length > 0
                                ? stdout.trim().substring(0, 2500)
                                : "(No description provided by Janito)"
                            await sock.sendMessage(remoteJid, {
                                text: `Repo cloned!\n\n${janitoDesc}\n\nWhat do you want to change? Please describe the change.\n\n----\n[Janito stdout]\n${stdout}\n[stderr]\n${stderr}`
                            })
                        }
                    })
                })
                .catch(async (err) => {
                    logger.error('Clone failed', { repoUrl, err })
                    await sock.sendMessage(remoteJid, { text: `Failed to clone: ${err}` })
                })
            return
        }

        // EXPLICIT /vibe COMMAND (code change)
        if (textContent.startsWith('/vibe ')) {
            const user = userState[remoteJid];
            if (!user?.repoPath) {
                await sock.sendMessage(remoteJid, { text: "No repo found for this conversation. Please /clone first." });
                return;
            }

            const repoPath = user.repoPath;
            const promptForJanito = textContent.replace('/vibe', '').trim();

            if (!promptForJanito) {
                await sock.sendMessage(remoteJid, { text: "Please provide a prompt, e.g., /vibe Change the title to Hello World." });
                return;
            }

            logger.info(`Running janito for prompt: ${promptForJanito} on ${repoPath}`)

            await sock.sendMessage(remoteJid, { text: "Applying your change with Janito, please wait..." });

            const janitoCmd = `cd ${repoPath} && janito "${promptForJanito.replace(/"/g, '\\"')}"`;
            logger.info(`Running: ${janitoCmd}`)
            exec(janitoCmd, async (err, stdout, stderr) => {
                logger.info('Janito /vibe result', { err, stdout, stderr })
                let msg = '';
                if (err) msg += `❌ Janito error:\n${err}\n\n`;
                if (stderr) msg += `⚠️ STDERR:\n${stderr}\n\n`;
                if (stdout) msg += `✅ STDOUT:\n${stdout}\n\n`;
                if (!msg) msg = 'No output from Janito.';

                userState[remoteJid].waitingForCommit = true;

                await sock.sendMessage(remoteJid, { 
                    text: `Changes done!\n\n${msg}\nDo you want me to commit? (yes/no)` 
                });
            });
            return;
        }

        // COMMIT
        if (userState[remoteJid]?.waitingForCommit) {
            if (/^(yes|commit)/i.test(textContent.trim())) {
                const repoPath = userState[remoteJid].repoPath
                const git = simpleGit(repoPath)
                logger.info('Committing changes', { repoPath })

                let gitMsg = '';
                try {
                    await git.add('.')
                    gitMsg += 'Staged all changes.\n'
                    const commitResult = await git.commit('Applied AI code changes')
                    gitMsg += `Commit result: ${JSON.stringify(commitResult)}\n`
                } catch (e) {
                    logger.error('Git commit error', { e })
                    gitMsg += `Git error: ${e}\n`
                }
                userState[remoteJid].waitingForCommit = false
                await sock.sendMessage(remoteJid, { text: `Committed!\n${gitMsg}\n(You can now /vibe again or /deploy.)` })
            } else {
                userState[remoteJid].waitingForCommit = false
                await sock.sendMessage(remoteJid, { text: "Changes not committed. You can send another instruction or /commit later." })
            }
            return
        }

        // FALLBACK AI OR ECHO
        if (config.bot.aiEnabled) {
            logger.info('Processing AI request', { prompt: textContent, from: remoteJid })
            try {
                const aiReply = await generateResponse(textContent)
                await sock.sendMessage(remoteJid, { text: aiReply })
                logger.info('AI response sent', { to: remoteJid, responseLength: aiReply.length })
            } catch (error) {
                logger.error('AI request failed', error)
                await sock.sendMessage(remoteJid, {
                    text: 'Sorry, AI is currently unavailable. Please try again later.'
                })
            }
            return
        } else {
            await sock.sendMessage(remoteJid, { text: `Echo: ${textContent}` })
        }

    } catch (error) {
        logger.error('Error handling message', error, {
            messageId: message.key.id,
            from: message.key.remoteJid
        })
        await sock.sendMessage(message.key.remoteJid, { text: `❗ Bot error: ${error}\n${JSON.stringify(error, null, 2)}` })
    }
}

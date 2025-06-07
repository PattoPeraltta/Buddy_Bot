import { BaileysEventMap, WASocket, WAMessage } from 'baileys'

import { config } from '../config/index.js'
import { generateResponse, chatWithRepoFunctions } from '../ai/openai.js'
import { createLogger } from '../logger/index.js'

import simpleGit from 'simple-git'
import { exec } from 'child_process'
import { saveToken, addRepo, listRepos, getToken, setActiveRepo, getActiveRepo } from '../db/index.js'
import { fetchUserRepos, formatRepoList, findRepoByName } from '../utils/github.js'

const logger = createLogger('MessageHandler')
const userState = {}

// Conversation history per user
const conversationHistory: { [key: string]: Array<{ role: 'user' | 'assistant', content: string, timestamp: Date }> } = {}

// Temporary GitHub repos cache for context
const githubReposCache: { [key: string]: any[] } = {}

function addToHistory(userJid: string, role: 'user' | 'assistant', content: string) {
    if (!conversationHistory[userJid]) {
        conversationHistory[userJid] = []
    }
    conversationHistory[userJid].push({ role, content, timestamp: new Date() })
    // Keep only last 20 messages
    if (conversationHistory[userJid].length > 20) {
        conversationHistory[userJid] = conversationHistory[userJid].slice(-20)
    }
}

function detectGitHubToken(text: string): string | null {
    // Detect GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_
    const tokenRegex = /gh[pous]_[A-Za-z0-9]{36}/g
    const match = text.match(tokenRegex)
    return match ? match[0] : null
}

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

function normalizePhone(jid: string): string {
    return jid.replace(/[^0-9]/g, '')
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

        // Allow only debug phone numbers
        const senderJid = message.key.participant || remoteJid
        const phone = normalizePhone(senderJid.split('@')[0])
        logger.info('Phone check', { senderJid, phone, allowedPhones: config.allowedPhones })
        if (!config.allowedPhones.includes(phone)) {
            logger.info('Phone not allowed, ignoring message')
            return
        }
        logger.info('Phone allowed, processing message')

        // Add user message to history
        addToHistory(remoteJid, 'user', textContent)

        // Auto-detect GitHub token in any message
        const detectedToken = detectGitHubToken(textContent)
        if (detectedToken) {
            logger.info('GitHub token detected', { tokenLength: detectedToken.length, tokenStart: detectedToken.substring(0, 10) })
            saveToken(remoteJid, detectedToken)
            logger.info('Token saved for user', { remoteJid })
            const response = '✅ GitHub token detected and saved automatically! You can now use repo commands.'
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
            return
        }

        // Help command
        if (textContent.startsWith('/help') || textContent.toLowerCase().includes('ayuda') || textContent.toLowerCase().includes('help')) {
            const response = `🤖 *Commeta - AI Coding Assistant*

I can help you manage GitHub repositories via WhatsApp!

*Commands:*
• \`/auth <token>\` - Save GitHub token
• \`/repos\` - List your GitHub repositories  
• \`/clone <url>\` - Clone repository
• \`/use <number>\` - Switch active repository
• \`/help\` - Show this help

*What I can do:*
✅ Clone any GitHub repository
✅ List all your GitHub repos (public & private)
✅ Edit code with AI assistance
✅ Commit and push changes automatically
✅ Switch between multiple projects
✅ Answer programming questions

*Getting started:*
1. Send me your GitHub token or use \`/auth <token>\`
2. Use \`/repos\` to see your repositories
3. Say "clone X repo" or use \`/clone <url>\`
4. Start coding! 🚀

Just chat with me naturally - I understand context!`
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
            return
        }

        // Check if user has GitHub token for repo-related commands
        const hasToken = getToken(remoteJid) !== null
        const isRepoCommand = textContent.startsWith('/clone ') || textContent.startsWith('/repos') || textContent.startsWith('/use ')
        
        if (isRepoCommand && !hasToken) {
            const response = '🔑 First, you need to configure your GitHub token.\n\nUse: /auth <your_github_token>\n\nOr just send me your GitHub token directly!\n\nGet your token from: https://github.com/settings/tokens'
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
            return
        }

        // 0. Save GitHub token
        if (textContent.startsWith('/auth ')) {
            const token = textContent.split(' ')[1]?.trim()
            if (!token) {
                const response = 'Usage: /auth <your_github_token>\n\nOr just send me your GitHub token directly!'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
            } else {
                saveToken(remoteJid, token)
                const response = '✅ GitHub token saved! You can now push commits.'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
            }
            return
        }

        // 0b. List cloned repos
        if (textContent.startsWith('/repos')) {
            try {
                const token = getToken(remoteJid)
                logger.info('Fetching repos for user', { remoteJid, hasToken: !!token })
                if (!token) {
                    const response = '🔑 Please configure your GitHub token first with /auth <token>'
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                    return
                }

                const loadingResponse = '🔄 Fetching your GitHub repositories...'
                await sock.sendMessage(remoteJid, { text: loadingResponse })
                addToHistory(remoteJid, 'assistant', loadingResponse)

                logger.info('About to fetch GitHub repos', { tokenLength: token.length, tokenStart: token.substring(0, 10) })
                const githubRepos = await fetchUserRepos(token)
                logger.info('GitHub repos fetched successfully', { repoCount: githubRepos.length })
                const localRepos = listRepos(remoteJid)
                
                // Cache GitHub repos for context
                githubReposCache[remoteJid] = githubRepos
                
                const response = formatRepoList(githubRepos, localRepos)
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
            } catch (error) {
                logger.error('Error fetching GitHub repos', error)
                const errorMessage = error instanceof Error ? error.message : String(error)
                logger.error('Detailed error:', { errorMessage, errorStack: error instanceof Error ? error.stack : 'No stack' })
                const response = `❌ Error fetching repositories: ${errorMessage}\n\nCheck your GitHub token or try again later.`
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
            }
            return
        }

        // 0c. Change active repo
        if (textContent.startsWith('/use ')) {
            const numStr = textContent.split(' ')[1]
            const idx = parseInt(numStr, 10)
            const repos = listRepos(remoteJid)
            let response: string
            if (isNaN(idx) || idx < 1 || idx > repos.length) {
                response = 'Usage: /use <repo_number> (see /repos)'
            } else {
                const repo = repos[idx - 1]
                setActiveRepo(remoteJid, repo.id)
                response = `Active repo set to: ${repo.repoUrl}`
            }
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
            return
        }

        // 1. Clone flow
        if (textContent.startsWith('/clone ')) {
            const repoUrl = textContent.split(' ')[1]
            const repoId = Date.now()
            const localPath = `./repos/${repoId}`

            // Clone
            simpleGit().clone(repoUrl, localPath)
                .then(async () => {
                    // Save repo association in DB
                    addRepo(remoteJid, repoUrl, localPath)
                    // Index with janito
                    exec(`cd ${localPath} && janito describe`, async (err, stdout, stderr) => {
                        if (err) {
                            const response = `Repo cloned but failed to describe repo: ${stderr || err}`
                            await sock.sendMessage(remoteJid, { text: response })
                            addToHistory(remoteJid, 'assistant', response)
                        } else {
                            userState[remoteJid] = { repoPath: localPath, waitingForEdit: true }
                            // Build the rich message
                            const janitoDesc = stdout && stdout.trim().length > 0
                                ? stdout.trim().substring(0, 2500) // Optional: limit length for WhatsApp
                                : "(No description provided by Janito)"
                            const response = `Repo cloned!\n\n${janitoDesc}\n\nWhat do you want to change? Please describe the change.`
                            await sock.sendMessage(remoteJid, { text: response })
                            addToHistory(remoteJid, 'assistant', response)
                        }
                    })
                })
                .catch(async (err) => {
                    const response = `Failed to clone: ${err}`
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                })
            return
        }

        // 2. If waiting for edit instruction
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
            await sock.sendMessage(remoteJid, { text: "🔄 Starting Janito process..." });

            const janitoCmd = `cd ${repoPath} && janito "${promptForJanito.replace(/"/g, '\\"')}"`;
            logger.info(`Running: ${janitoCmd}`)

            // Create a child process with stdio set to pipe
            const { spawn } = require('child_process');
            const [cmd, ...args] = janitoCmd.split(' ');
            const janitoProcess = spawn(cmd, args, { shell: true });

            let currentSection = '';
            let buffer = '';

            // Handle stdout data
            janitoProcess.stdout.on('data', async (data) => {
                const output = data.toString();
                buffer += output;

                // Check for section headers
                const sections = ['Implementation plan:', 'Discovery:', 'Description:', 'Implementation:', 'Validation:'];
                for (const section of sections) {
                    if (output.includes(section)) {
                        // If we have buffered content from previous section, send it
                        if (buffer && currentSection) {
                            await sock.sendMessage(remoteJid, { 
                                text: `📝 *${currentSection}*\n${buffer.trim()}`
                            });
                            buffer = '';
                        }
                        currentSection = section;
                        break;
                    }
                }

                // If we have a complete line, send it
                if (buffer.includes('\n')) {
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // Keep the last incomplete line in buffer
                    
                    for (const line of lines) {
                        if (line.trim()) {
                            await sock.sendMessage(remoteJid, { 
                                text: `📝 *${currentSection || 'Progress'}*\n${line.trim()}`
                            });
                        }
                    }
                }
            });

            // Handle stderr data
            janitoProcess.stderr.on('data', async (data) => {
                const error = data.toString();
                if (error.trim()) {
                    await sock.sendMessage(remoteJid, { 
                        text: `⚠️ *Error*\n${error.trim()}`
                    });
                }
            });

            // Handle process completion
            janitoProcess.on('close', async (code) => {
                // Send any remaining buffered content
                if (buffer.trim()) {
                    await sock.sendMessage(remoteJid, { 
                        text: `📝 *${currentSection || 'Final Output'}*\n${buffer.trim()}`
                    });
                }

                if (code === 0) {
                    userState[remoteJid].waitingForCommit = true;
                    await sock.sendMessage(remoteJid, { 
                        text: "✅ Janito process completed!\n\nDo you want me to commit these changes? (yes/no)"
                    });
                } else {
                    await sock.sendMessage(remoteJid, { 
                        text: `❌ Janito process exited with code ${code}`
                    });
                }
            });

            return;
        }

        // 3. If waiting for commit confirmation
        if (userState[remoteJid]?.waitingForCommit) {
            if (/^(yes|commit)/i.test(textContent.trim())) {
                const repoPath = userState[remoteJid].repoPath
                const git = simpleGit(repoPath)
                await git.add('.')
                await git.commit('Applied AI code changes')
                // Push if we have a stored token
                try {
                    const token = getToken(remoteJid)
                    if (token) {
                        const originUrlRes = await git.remote(['get-url', 'origin'])
                        const originUrl = (originUrlRes ?? '').toString().trim()
                        const tokenUrl = originUrl.replace('https://', `https://${token}@`)
                        await git.remote(['set-url', 'origin', tokenUrl])
                        await git.push('origin', 'HEAD')
                        // Restore original URL without the token for safety
                        await git.remote(['set-url', 'origin', originUrl])
                        const response = 'Changes pushed to GitHub! 🚀'
                        await sock.sendMessage(remoteJid, { text: response })
                        addToHistory(remoteJid, 'assistant', response)
                    } else {
                        const response = 'Commit saved locally. Configure a GitHub token with /auth to enable pushing.'
                        await sock.sendMessage(remoteJid, { text: response })
                        addToHistory(remoteJid, 'assistant', response)
                    }
                } catch (pushErr) {
                    logger.error('Git push failed', pushErr)
                    const response = `Commit saved, but push failed: ${pushErr}`
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                }
                userState[remoteJid].waitingForCommit = false
            } else {
                userState[remoteJid].waitingForCommit = false
                const response = "Changes not committed. You can send another instruction or /commit later."
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
            }
            return
        }

        // Natural language clone detection (e.g., "clone myproject", "clona repo-name")
        const clonePatterns = [
            /(?:clone|clona|clonar)\s+([a-zA-Z0-9\-_.]+)/i,
            /(?:clone|clona|clonar)\s+"([^"]+)"/i,
            /(?:clone|clona|clonar)\s+'([^']+)'/i
        ]
        
        for (const pattern of clonePatterns) {
            const match = textContent.match(pattern)
            if (match) {
                const repoName = match[1].trim()
                const cachedRepos = githubReposCache[remoteJid]
                
                if (cachedRepos && cachedRepos.length > 0) {
                    const foundRepo = findRepoByName(cachedRepos, repoName)
                    if (foundRepo) {
                        // Use the found repo's clone URL
                        const repoId = Date.now()
                        const localPath = `./repos/${repoId}`
                        
                        const startResponse = `🔄 Cloning ${foundRepo.name} (${foundRepo.clone_url})...`
                        await sock.sendMessage(remoteJid, { text: startResponse })
                        addToHistory(remoteJid, 'assistant', startResponse)

                        simpleGit().clone(foundRepo.clone_url, localPath)
                            .then(async () => {
                                addRepo(remoteJid, foundRepo.clone_url, localPath)
                                exec(`cd ${localPath} && janito describe`, async (err, stdout, stderr) => {
                                    if (err) {
                                        const response = `Repo cloned but failed to describe repo: ${stderr || err}`
                                        await sock.sendMessage(remoteJid, { text: response })
                                        addToHistory(remoteJid, 'assistant', response)
                                    } else {
                                        userState[remoteJid] = { repoPath: localPath, waitingForEdit: true }
                                        const janitoDesc = stdout && stdout.trim().length > 0
                                            ? stdout.trim().substring(0, 2500)
                                            : "(No description provided by Janito)"
                                        const response = `✅ ${foundRepo.name} cloned successfully!\n\n${janitoDesc}\n\nWhat do you want to change? Please describe the change.`
                                        await sock.sendMessage(remoteJid, { text: response })
                                        addToHistory(remoteJid, 'assistant', response)
                                    }
                                })
                            })
                            .catch(async (err) => {
                                const response = `❌ Failed to clone ${foundRepo.name}: ${err}`
                                await sock.sendMessage(remoteJid, { text: response })
                                addToHistory(remoteJid, 'assistant', response)
                            })
                        return
                    } else {
                        const response = `❌ Repository "${repoName}" not found in your GitHub repos.\n\nUse /repos to see available repositories.`
                        await sock.sendMessage(remoteJid, { text: response })
                        addToHistory(remoteJid, 'assistant', response)
                        return
                    }
                } else {
                    const response = `❌ No GitHub repositories cached. Use /repos first to load your repositories.`
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                    return
                }
            }
        }

        // AI fallback or echo
        try {
            logger.info('Entering AI fallback', { textContent, aiEnabled: config.bot.aiEnabled })
            if (config.bot.aiEnabled) {
                const history = conversationHistory[remoteJid] || []
                const cachedGithubRepos = githubReposCache[remoteJid] || []
                logger.info('AI context', { 
                    historyLength: history.length, 
                    cachedReposCount: cachedGithubRepos.length,
                    hasToken: !!getToken(remoteJid)
                })
                
                // If asking about repos but no cache, suggest /repos first
                const isRepoQuestion = /(?:repo|repositor)/i.test(textContent)
                if (isRepoQuestion && cachedGithubRepos.length === 0 && getToken(remoteJid)) {
                    const response = "I don't have your GitHub repositories cached yet. Use `/repos` first to load them, then I can help you with repository questions!"
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                    return
                }
                
                const response = await chatWithRepoFunctions(remoteJid, textContent, history, cachedGithubRepos)
                logger.info('AI response generated', { responseLength: response.length })
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
            } else {
                const response = `Echo: ${textContent}`
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
            }
        } catch (error) {
            logger.error('Error in fallback response', error)
            const response = 'Error processing your message.'
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
        }
    } catch (error) {
        logger.error('Error handling message', error, {
            messageId: message.key.id,
            from: message.key.remoteJid
        })
    }
}
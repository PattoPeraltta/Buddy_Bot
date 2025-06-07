import { BaileysEventMap, WASocket, WAMessage } from 'baileys'

import { config } from '../config/index.js'
import { generateResponse, chatWithRepoFunctions } from '../ai/openai.js'
import { createLogger } from '../logger/index.js'

import simpleGit from 'simple-git'
import { exec, execSync } from 'child_process'
import { saveToken, addRepo, listRepos, getToken, setActiveRepo, getActiveRepo, saveVercelToken, getVercelToken } from '../db/index.js'
import { fetchUserRepos, formatRepoList, findRepoByName } from '../utils/github.js'
import { handleAudioMessage } from './audioHandler.js'
import { 
    isVercelCliInstalled, 
    deployToVercel, 
    getVercelStatus, 
    getVercelLogs,
    detectProjectType,
    generateVercelJson,
    validateVercelToken,
    testVercelToken
} from '../utils/vercel.js'
import fs from 'fs'
import path from 'path'

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

async function generateCommitMessage(repoPath: string, userPrompt: string): Promise<string> {
    return new Promise((resolve) => {
        // Get git diff to understand changes
        exec(`cd ${repoPath} && git diff --staged`, (err, stdout, stderr) => {
            if (err || !stdout.trim()) {
                // Fallback to generic message
                resolve(`feat: ${userPrompt}`)
                return
            }
            
            const diff = stdout.trim()
            let commitMessage = ''
            
            // Analyze diff to generate semantic commit message
            if (diff.includes('package.json') || diff.includes('yarn.lock') || diff.includes('package-lock.json')) {
                commitMessage = 'chore: update dependencies'
            } else if (diff.includes('README') || diff.includes('.md')) {
                commitMessage = 'docs: update documentation'
            } else if (diff.includes('test') || diff.includes('.test.') || diff.includes('.spec.')) {
                commitMessage = 'test: update tests'
            } else if (diff.includes('.css') || diff.includes('.scss') || diff.includes('style')) {
                commitMessage = 'style: update styling'
            } else if (diff.includes('config') || diff.includes('.env') || diff.includes('settings')) {
                commitMessage = 'config: update configuration'
            } else if (diff.includes('+ ') && !diff.includes('- ')) {
                commitMessage = `feat: ${userPrompt}`
            } else if (diff.includes('- ') && diff.includes('+ ')) {
                commitMessage = `refactor: ${userPrompt}`
            } else if (diff.includes('fix') || diff.includes('bug') || userPrompt.toLowerCase().includes('fix')) {
                commitMessage = `fix: ${userPrompt}`
            } else {
                commitMessage = `feat: ${userPrompt}`
            }
            
            resolve(commitMessage)
        })
    })
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

        // Handle audio messages
        if (message.message?.audioMessage) {
            await handleAudioMessage(sock, message)
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
• \`/use <repo-name>\` - Switch active repository
• \`/local\` - List only local cloned repositories
• \`/vibe <prompt>\` - Edit code with AI (e.g., /vibe add login form)
• \`/status\` - Show current repo and git status
• \`/current\` or \`/active\` - Show current active repository
• \`/deploy\` - Deploy current repo to Vercel 🚀
• \`/deploy-preview\` - Deploy as preview (staging)
• \`/vercel-status\` - Check Vercel deployment status
• \`/vercel-auth\` - Authenticate with Vercel CLI
• \`/vercel-token <token>\` - Save Vercel authentication token
• \`/vercel-test\` - Test your stored Vercel token
• \`/vercel-logs\` - Get deployment logs
• \`/help\` - Show this help

*What I can do:*
✅ Clone any GitHub repository
✅ List all your GitHub repos (public & private)
✅ Edit code with AI assistance
✅ Commit and push changes automatically
✅ Switch between multiple projects
✅ Answer programming questions
✅ Generate intelligent commit messages
✅ Prevent duplicate cloning
✅ Track git status and changes
✅ Deploy to Vercel with one command! 🌐

*Getting started:*
1. Send me your GitHub token or use \`/auth <token>\`
2. Use \`/repos\` to see your repositories
3. Say "clone X repo" or use \`/clone <url>\`
4. Use \`/vibe <what you want>\` to edit code
5. Use \`/vercel-token <token>\` to save your Vercel token
6. Use \`/deploy\` to deploy to Vercel!

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

        // Save Vercel token
        if (textContent.startsWith('/vercel-token ')) {
            const token = textContent.split(' ')[1]?.trim()
            if (!token) {
                const response = '🔐 Usage: /vercel-token <your_vercel_token>\n\nGet your Vercel token from:\n1. Visit https://vercel.com/account/tokens\n2. Create a new token\n3. Copy and use with this command'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
            } else {
                // Validate token format first
                if (!validateVercelToken(token)) {
                    const response = '❌ Invalid token format!\n\nVercel tokens should be:\n• 20+ characters long\n• No spaces or line breaks\n• Complete token (not truncated)\n\nPlease get a fresh token from https://vercel.com/account/tokens'
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                    return
                }
                
                // Test the token
                await sock.sendMessage(remoteJid, { text: '🔍 Testing token...' })
                
                const testResult = await testVercelToken(token)
                if (testResult.valid) {
                    saveVercelToken(remoteJid, token)
                    const response = `✅ Vercel token saved and verified!\n\n${testResult.message}\n\nYou can now use /deploy or /deploy-preview to deploy your projects.`
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                } else {
                    const response = `❌ Token validation failed!\n\n${testResult.message}\n\nPlease:\n1. Get a fresh token from https://vercel.com/account/tokens\n2. Make sure you copy the complete token\n3. Ensure the token has proper permissions`
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                }
            }
            return
        }

        // Test stored Vercel token
        if (textContent.startsWith('/vercel-test')) {
            const storedToken = getVercelToken(remoteJid)
            if (!storedToken) {
                const response = '❌ No Vercel token found!\n\nUse `/vercel-token <your_token>` to save one first.'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
                return
            }
            
            await sock.sendMessage(remoteJid, { text: '🔍 Testing stored token...' })
            
            const testResult = await testVercelToken(storedToken)
            const response = testResult.valid 
                ? `✅ Token is valid!\n\n${testResult.message}`
                : `❌ Stored token is invalid!\n\n${testResult.message}\n\nUse \`/vercel-token <new_token>\` to update it.`
            
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
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
                
                // Show repos with simple format
                let response = `📚 *Your GitHub Repositories:*\n\n`
                githubRepos.slice(0, 20).forEach(repo => {
                    const isLocal = localRepos.some(local => local.repoUrl === repo.clone_url)
                    const localIcon = isLocal ? '📁' : ''
                    const privateIcon = repo.private ? '🔒' : '🌐'
                    const lang = repo.language ? `[${repo.language}]` : ''
                    const activeIcon = isLocal && getActiveRepo(remoteJid)?.repoUrl === repo.clone_url ? ' ⭐' : ''
                    
                    response += `${privateIcon} ${repo.name} ${lang} ${localIcon}${activeIcon}\n`
                })
                response += `\n💡 Use "/use repo-name" to switch or "clone repo-name" to clone!`
                
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
            const repoName = textContent.split(' ').slice(1).join(' ').trim()
            const repos = listRepos(remoteJid)
            logger.info('Use command called', { repoName, availableRepos: repos.length })
            let response: string
            
            if (!repoName) {
                if (repos.length === 0) {
                    response = '❌ No repositories cloned yet.\n\nUse "/clone <url>" or "clone repo-name" to get started.'
                } else {
                    response = `📁 *Available Local Repositories:*\n\n`
                    repos.forEach((repo, idx) => {
                        const repoName = repo.repoUrl.split('/').pop()?.replace('.git', '')
                        const activeIcon = getActiveRepo(remoteJid)?.id === repo.id ? ' ⭐ (active)' : ''
                        response += `• ${repoName}${activeIcon}\n`
                    })
                    response += `\n💡 Use "/use <repo-name>" to switch!\nExample: /use ${repos[0].repoUrl.split('/').pop()?.replace('.git', '') || 'repo-name'}`
                }
            } else {
                // Find repo by name (extract repo name from URL)
                logger.info('Searching for repo', { searchName: repoName, repos: repos.map(r => ({
                    id: r.id,
                    url: r.repoUrl,
                    extractedName: r.repoUrl.split('/').pop()?.replace('.git', '')
                }))})
                
                const foundRepo = repos.find(repo => {
                    const urlParts = repo.repoUrl.split('/')
                    const repoNameFromUrl = urlParts[urlParts.length - 1].replace('.git', '')
                    logger.info('Comparing names', { 
                        searchName: repoName.toLowerCase(), 
                        repoName: repoNameFromUrl.toLowerCase(),
                        matches: repoNameFromUrl.toLowerCase() === repoName.toLowerCase() ||
                               repoNameFromUrl.toLowerCase().includes(repoName.toLowerCase())
                    })
                    return repoNameFromUrl.toLowerCase() === repoName.toLowerCase() ||
                           repoNameFromUrl.toLowerCase().includes(repoName.toLowerCase())
                })
                
                if (foundRepo) {
                    setActiveRepo(remoteJid, foundRepo.id)
                    const repoNameClean = foundRepo.repoUrl.split('/').pop()?.replace('.git', '') || 'repo'
                    logger.info('Active repo set', { repoId: foundRepo.id, repoName: repoNameClean })
                    response = `✅ Active repo set to: ${repoNameClean}`
                } else {
                    const availableNames = repos.map(r => r.repoUrl.split('/').pop()?.replace('.git', '')).join(', ')
                    response = `❌ Repository "${repoName}" not found.\n\nAvailable repos: ${availableNames}\n\nUse "/use" to see all options.`
                }
            }
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
            return
        }

        // List local repos only
        if (textContent.startsWith('/local')) {
            const repos = listRepos(remoteJid)
            let response: string
            if (repos.length === 0) {
                response = 'No repositories cloned locally. Use /clone <url> or "clone repo-name" to get started.'
            } else {
                response = `📁 *Local Repositories:*\n\n`
                repos.forEach(repo => {
                    const repoName = repo.repoUrl.split('/').pop()?.replace('.git', '') || 'unknown'
                    const activeIcon = getActiveRepo(remoteJid)?.id === repo.id ? ' ⭐' : ''
                    response += `${repoName}${activeIcon}\n`
                })
                response += `\n💡 Use "/use repo-name" to switch active repository!`
            }
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
            return
        }

        // 1. Clone flow
        if (textContent.startsWith('/clone ')) {
            const repoUrl = textContent.split(' ')[1]
            
            // Check if repo is already cloned
            const existingRepo = listRepos(remoteJid).find(r => r.repoUrl === repoUrl)
            if (existingRepo) {
                const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'repository'
                const response = `📁 Repository already cloned!\n\nUse "/use ${repoName}" to switch to it or /vibe to edit.`
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
                return
            }
            
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
                            // Build the rich message
                            const janitoDesc = stdout && stdout.trim().length > 0
                                ? stdout.trim().substring(0, 2500) // Optional: limit length for WhatsApp
                                : "(No description provided by Janito)"
                            const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'repository'
                            const response = `✅ ${repoName} cloned and set as active!\n\n${janitoDesc}\n\nUse "/vibe <description>" to edit or "/status" to see git status.`
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
            const activeRepo = getActiveRepo(remoteJid)
            if (!activeRepo) {
                await sock.sendMessage(remoteJid, { text: "❌ No active repository. Use /repos to list or /clone to add repositories." });
                return;
            }

            const repoPath = activeRepo.localPath;
            const promptForJanito = textContent.replace('/vibe', '').trim();

            if (!promptForJanito) {
                await sock.sendMessage(remoteJid, { text: "Please provide a prompt, e.g., /vibe Change the title to Hello World." });
                return;
            }

            logger.info(`Running janito for prompt: ${promptForJanito} on ${repoPath}`)
            await sock.sendMessage(remoteJid, { text: "🔄 Starting Janito process..." });

            const janitoCmd = `cd ${repoPath} && janito "${promptForJanito.replace(/"/g, '\\"')}"`;
            logger.info(`Running: ${janitoCmd}`)
            exec(janitoCmd, async (err, stdout, stderr) => {
                logger.info('Janito /vibe result', { err, stdout, stderr })
                let msg = '';
                if (err) msg += `❌ Janito error:\n${err}\n\n`;
                if (stderr) msg += `⚠️ STDERR:\n${stderr}\n\n`;
                if (stdout) msg += `✅ STDOUT:\n${stdout}\n\n`;
                if (!msg) msg = 'No output from Janito.';

                userState[remoteJid] = { repoPath, waitingForCommit: true, lastPrompt: promptForJanito }

                await sock.sendMessage(remoteJid, { 
                    text: `Changes done!\n\n${msg}\nDo you want me to commit? (yes/no)` 
                });
            });

            return;
        }

        // 3. If waiting for commit confirmation
        if (userState[remoteJid]?.waitingForCommit) {
            const { repoPath, lastPrompt } = userState[remoteJid]
            const git = simpleGit(repoPath)

            if (textContent.toLowerCase().includes('yes') || textContent.toLowerCase().includes('y')) {
                // Auto-generate commit message with AI
                const commitMessage = `AI: ${lastPrompt}`

                try {
                    await git.add('.')
                    await git.commit(commitMessage)

                    // Get GitHub token and push if available
                    const token = getToken(remoteJid)
                    if (token) {
                        const remotes = await git.getRemotes(true)
                        const originUrl = remotes.find(r => r.name === 'origin')?.refs?.fetch
                        if (originUrl) {
                            const tokenUrl = originUrl.replace('https://', `https://${token}@`)
                            await git.remote(['set-url', 'origin', tokenUrl])
                            await git.push('origin', 'HEAD')
                            // Restore original URL without the token for safety
                            await git.remote(['set-url', 'origin', originUrl])
                        }
                        const response = `✅ Changes committed and pushed to GitHub!\n\nCommit: ${commitMessage} 🚀`
                        await sock.sendMessage(remoteJid, { text: response })
                        addToHistory(remoteJid, 'assistant', response)
                        
                        // Ask if they want to deploy to Vercel
                        if (isVercelCliInstalled()) {
                            const deployPrompt = '🚀 Would you like to deploy to Vercel? Reply with "deploy" or "yes" to proceed.'
                            await sock.sendMessage(remoteJid, { text: deployPrompt })
                            addToHistory(remoteJid, 'assistant', deployPrompt)
                            
                            // Set a flag to handle the next message as a deploy confirmation
                            userState[remoteJid].waitingForDeployConfirm = true
                        }
                    } else {
                        const response = `✅ Changes committed locally!\n\nCommit: ${commitMessage}\n\nConfigure a GitHub token with /auth to enable pushing.`
                        await sock.sendMessage(remoteJid, { text: response })
                        addToHistory(remoteJid, 'assistant', response)
                    }
                } catch (pushErr) {
                    logger.error('Git push failed', pushErr)
                    const response = `✅ Committed: ${commitMessage}\n\n❌ Push failed: ${pushErr}`
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

        // 4. If waiting for deploy confirmation
        if (userState[remoteJid]?.waitingForDeployConfirm) {
            const activeRepo = getActiveRepo(remoteJid)
            
            if (textContent.toLowerCase().includes('deploy') || textContent.toLowerCase().includes('yes') || textContent.toLowerCase().includes('y')) {
                if (activeRepo) {
                    await sock.sendMessage(remoteJid, { text: '🚀 Starting Vercel deployment...' })
                    
                    const result = await deployToVercel(activeRepo.localPath, true)
                    await sock.sendMessage(remoteJid, { text: result.message })
                    addToHistory(remoteJid, 'assistant', result.message)
                } else {
                    const response = '❌ No active repository found for deployment.'
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                }
            } else {
                const response = 'Deployment skipped. You can deploy later using /deploy command.'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
            }
            
            userState[remoteJid].waitingForDeployConfirm = false
            return
        }

        // Status command - show current repo and git status
        if (textContent.startsWith('/status')) {
            const activeRepo = getActiveRepo(remoteJid)
            if (!activeRepo) {
                const response = '❌ No active repository. Use /repos to list or /clone to add repositories.'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
                return
            }
            
            // Get git status
            exec(`cd ${activeRepo.localPath} && git status --porcelain`, (err, stdout, stderr) => {
                const repoName = activeRepo.repoUrl.split('/').pop()?.replace('.git', '') || 'unknown'
                let statusMsg = `📁 *Active Repository:* ${repoName}\n\n`
                
                if (err) {
                    statusMsg += '❌ Error getting git status'
                } else if (!stdout.trim()) {
                    statusMsg += '✅ Working directory clean'
                } else {
                    const changes = stdout.trim().split('\n')
                    statusMsg += `📝 *Changes (${changes.length}):*\n`
                    changes.slice(0, 10).forEach(change => {
                        const status = change.substring(0, 2)
                        const file = change.substring(3)
                        const icon = status.includes('M') ? '📝' : status.includes('A') ? '➕' : status.includes('D') ? '➖' : '❓'
                        statusMsg += `${icon} ${file}\n`
                    })
                    if (changes.length > 10) {
                        statusMsg += `... and ${changes.length - 10} more files\n`
                    }
                }
                
                sock.sendMessage(remoteJid, { text: statusMsg })
                addToHistory(remoteJid, 'assistant', statusMsg)
            })
            return
        }

        // Show current active repo
        if (textContent.startsWith('/current') || textContent.startsWith('/active')) {
            const activeRepo = getActiveRepo(remoteJid)
            let response: string
            
            if (!activeRepo) {
                const repos = listRepos(remoteJid)
                if (repos.length === 0) {
                    response = '❌ No repositories cloned.\n\nUse "/clone <url>" or "clone repo-name" to get started.'
                } else {
                    response = '❌ No active repository set.\n\nUse "/use <repo-name>" to select one.'
                }
            } else {
                const repoName = activeRepo.repoUrl.split('/').pop()?.replace('.git', '') || 'unknown'
                response = `⭐ *Current Active Repository:*\n\n${repoName}\n\nUse "/status" for more details or "/use <name>" to switch.`
            }
            
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
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
                        // Check if repo is already cloned
                        const existingRepo = listRepos(remoteJid).find(r => r.repoUrl === foundRepo.clone_url)
                        if (existingRepo) {
                            const response = `📁 Repository "${foundRepo.name}" already cloned!\n\nUse "/use ${foundRepo.name}" to switch to it or /vibe to edit.`
                            await sock.sendMessage(remoteJid, { text: response })
                            addToHistory(remoteJid, 'assistant', response)
                            return
                        }
                        
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
                                        const janitoDesc = stdout && stdout.trim().length > 0
                                            ? stdout.trim().substring(0, 2500)
                                            : "(No description provided by Janito)"
                                        const response = `✅ ${foundRepo.name} cloned and set as active!\n\n${janitoDesc}\n\nUse "/vibe <description>" to edit or "/status" to see git status.`
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

        // Vercel authentication command
        if (textContent.startsWith('/vercel-auth')) {
            const response = '🔐 **Vercel Authentication Guide**\n\nTo deploy to Vercel via WhatsApp:\n\n**Step 1:** Get your token\n• Visit https://vercel.com/account/tokens\n• Click "Create Token"\n• Give it a name (e.g., "WhatsApp Bot")\n• Copy the complete token\n\n**Step 2:** Send it to me\n• Type: `/vercel-token <your_token>`\n• I\'ll validate and store it securely\n\n**Step 3:** Deploy!\n• Use `/deploy` for production\n• Use `/deploy-preview` for staging\n\n💡 Your token stays encrypted and is only used for your deployments!'
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
            return
        }

        // Vercel deployment command
        if (textContent.startsWith('/deploy')) {
            const activeRepo = getActiveRepo(remoteJid)
            if (!activeRepo) {
                const response = '❌ No active repository. Use /repos to list or /clone to add repositories.'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
                return
            }

            const repoPath = activeRepo.localPath

            // Check if Vercel CLI is installed
            if (!isVercelCliInstalled()) {
                const response = '⚠️ Vercel CLI not found!\n\nPlease install it first:\n```npm install -g vercel```\n\nThen use /vercel-token to save your token.'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
                return
            }

            // Detect project type and optionally generate vercel.json
            const projectType = detectProjectType(repoPath)
            if (projectType) {
                const generated = generateVercelJson(repoPath, projectType)
                if (generated) {
                    const infoMsg = `📝 Detected ${projectType} project - generated vercel.json`
                    await sock.sendMessage(remoteJid, { text: infoMsg })
                }
            }

            await sock.sendMessage(remoteJid, { text: '🚀 **Starting Deployment...**\n\n⏱️ This might take 2-5 minutes for larger projects.' })
            addToHistory(remoteJid, 'assistant', '🚀 Starting Vercel deployment...')

            // Get stored Vercel token
            const vercelToken = getVercelToken(remoteJid)

            // Send progress update after 1 minute
            setTimeout(async () => {
                await sock.sendMessage(remoteJid, { text: '⏳ **Still Building...**\n\nVercel is compiling your project.' })
            }, 60000)

            // Deploy to Vercel using utility function with token
            try {
                const result = await deployToVercel(repoPath, true, vercelToken || undefined)
                await sock.sendMessage(remoteJid, { text: result.message })
                addToHistory(remoteJid, 'assistant', result.message)
            } catch (error) {
                const errorMsg = `❌ Deployment error: ${error}\n\nTry using /vercel-status to check if it deployed anyway.`
                await sock.sendMessage(remoteJid, { text: errorMsg })
                addToHistory(remoteJid, 'assistant', errorMsg)
            }
            
            return
        }

        // Vercel status command
        if (textContent.startsWith('/vercel-status')) {
            const activeRepo = getActiveRepo(remoteJid)
            if (!activeRepo) {
                const response = '❌ No active repository. Use /repos to list or /clone to add repositories.'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
                return
            }

            const repoPath = activeRepo.localPath

            // Check if Vercel CLI is installed
            if (!isVercelCliInstalled()) {
                const response = '⚠️ Vercel CLI not found! Install with: `npm install -g vercel`'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
                return
            }

            await sock.sendMessage(remoteJid, { text: '🔍 Checking Vercel deployment status...' })

            // Get stored Vercel token
            const vercelToken = getVercelToken(remoteJid)

            // Check deployment status using utility function with token
            const result = await getVercelStatus(repoPath, vercelToken || undefined)
            await sock.sendMessage(remoteJid, { text: result.message })
            addToHistory(remoteJid, 'assistant', result.message)
            
            return
        }

        // Vercel logs command
        if (textContent.startsWith('/vercel-logs')) {
            const activeRepo = getActiveRepo(remoteJid)
            if (!activeRepo) {
                const response = '❌ No active repository. Use /repos to list or /clone to add repositories.'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
                return
            }

            const repoPath = activeRepo.localPath

            // Check if Vercel CLI is installed
            if (!isVercelCliInstalled()) {
                const response = '⚠️ Vercel CLI not found! Install with: `npm install -g vercel`'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
                return
            }

            await sock.sendMessage(remoteJid, { text: '📜 Fetching deployment logs...' })

            // Get stored Vercel token
            const vercelToken = getVercelToken(remoteJid)

            // Get deployment logs using utility function with token
            const result = await getVercelLogs(repoPath, 50, vercelToken || undefined)
            await sock.sendMessage(remoteJid, { text: result.message })
            addToHistory(remoteJid, 'assistant', result.message)
            
            return
        }

        // Vercel preview deployment command
        if (textContent.startsWith('/deploy-preview')) {
            const activeRepo = getActiveRepo(remoteJid)
            if (!activeRepo) {
                const response = '❌ No active repository. Use /repos to list or /clone to add repositories.'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
                return
            }

            const repoPath = activeRepo.localPath

            // Check if Vercel CLI is installed
            if (!isVercelCliInstalled()) {
                const response = '⚠️ Vercel CLI not found!\n\nPlease install it first:\n```npm install -g vercel```\n\nThen use /vercel-token to save your token.'
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
                return
            }

            // Detect project type and optionally generate vercel.json
            const projectType = detectProjectType(repoPath)
            if (projectType) {
                const generated = generateVercelJson(repoPath, projectType)
                if (generated) {
                    const infoMsg = `📝 Detected ${projectType} project - generated vercel.json`
                    await sock.sendMessage(remoteJid, { text: infoMsg })
                }
            }

            await sock.sendMessage(remoteJid, { text: '🔧 Starting preview deployment...' })
            addToHistory(remoteJid, 'assistant', '🔧 Starting preview deployment...')

            // Get stored Vercel token
            const vercelToken = getVercelToken(remoteJid)

            // Deploy to Vercel as preview (not production) with token
            const result = await deployToVercel(repoPath, false, vercelToken || undefined)
            await sock.sendMessage(remoteJid, { text: result.message })
            addToHistory(remoteJid, 'assistant', result.message)
            
            return
        }

        // Debug command for deployment troubleshooting
        if (textContent.startsWith('/debug-deploy')) {
            const activeRepo = getActiveRepo(remoteJid)
            if (!activeRepo) {
                const response = '❌ No active repository set.'
                await sock.sendMessage(remoteJid, { text: response })
                return
            }

            const repoPath = activeRepo.localPath
            const hasVercelToken = !!getVercelToken(remoteJid)
            const hasVercelCli = isVercelCliInstalled()
            
            // Check if it's a valid project
            const projectType = detectProjectType(repoPath)
            
            // Check if .vercel directory exists
            const fs = await import('fs')
            const path = await import('path')
            const vercelDir = path.join(repoPath, '.vercel')
            const hasVercelDir = fs.existsSync(vercelDir)
            
            let debugInfo = `🔍 **Deployment Debug**\n\n`
            debugInfo += `📁 **Repo:** ${activeRepo.repoUrl.split('/').pop()?.replace('.git', '')}\n`
            debugInfo += `🔑 **Token:** ${hasVercelToken ? '✅' : '❌'}\n`
            debugInfo += `⚙️ **CLI:** ${hasVercelCli ? '✅' : '❌'}\n`
            debugInfo += `🎯 **Type:** ${projectType || 'Unknown'}\n`
            debugInfo += `📋 **Config:** ${hasVercelDir ? '✅' : '❌'}`
            
            await sock.sendMessage(remoteJid, { text: debugInfo })
            addToHistory(remoteJid, 'assistant', debugInfo)
            return
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
        logger.error('Error handling message', { error })
    }
}
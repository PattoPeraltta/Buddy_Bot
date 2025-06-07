import { BaileysEventMap, WASocket, WAMessage } from 'baileys'

import { config } from '../config/index.js'
import { generateResponse, chatWithRepoFunctions, synthesizeProgressMessage } from '../ai/openai.js'
import { createLogger } from '../logger/index.js'

import simpleGit from 'simple-git'
import { exec, spawn } from 'child_process'
import { saveToken, addRepo, listRepos, getToken, setActiveRepo, getActiveRepo } from '../db/index.js'
import { fetchUserRepos, formatRepoList, findRepoByName } from '../utils/github.js'
import { handleAudioMessage } from './audioHandler.js'

const logger = createLogger('MessageHandler')

// Conversation history per user - exported for sharing with audioHandler
export const conversationHistory: { [key: string]: Array<{ role: 'user' | 'assistant', content: string, timestamp: Date }> } = {}

// Temporary GitHub repos cache for context - exported for sharing with audioHandler
export const githubReposCache: { [key: string]: any[] } = {}

// User state for commit waiting - exported for sharing with audioHandler  
export const userState = {}

export function addToHistory(userJid: string, role: 'user' | 'assistant', content: string) {
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

async function runJanitoWithProgress(
    sock: WASocket, 
    remoteJid: string, 
    repoPath: string, 
    prompt: string
): Promise<{ success: boolean, output: string, hasChanges: boolean }> {
    return new Promise((resolve) => {
        logger.info(`Running janito with progress: ${prompt} on ${repoPath}`)
        
        // Use spawn with shell command to properly quote the janito prompt
        const janitoProcess = spawn('sh', ['-c', `janito "${prompt}"`], {
            cwd: repoPath,
            stdio: ['pipe', 'pipe', 'pipe']
        })

        let output = ''
        let errorOutput = ''
        
        // Collect all output without sending progress messages
        janitoProcess.stdout.on('data', (data) => {
            output += data.toString()
        })

        janitoProcess.stderr.on('data', (data) => {
            errorOutput += data.toString()
        })

        // Handle process completion
        janitoProcess.on('close', async (code) => {
            logger.info('Janito process finished', { code, outputLength: output.length, errorLength: errorOutput.length })
            
            const success = code === 0
            let hasChanges = false
            
            if (success && output.trim()) {
                // Generate 3 different progress messages from the complete output
                try {
                    const messages = await generateProgressMessages(output)
                    
                    // Send messages with random delays
                    for (let i = 0; i < messages.length; i++) {
                        if (i > 0) {
                            // Random delay between 500ms and 2000ms
                            const delay = Math.random() * 1500 + 500
                            await new Promise(resolve => setTimeout(resolve, delay))
                        }
                        await sock.sendMessage(remoteJid, { text: messages[i] })
                    }
                } catch (error) {
                    logger.error('Error generating progress messages:', error)
                }
                
                // Check if there are actual git changes
                exec('git status --porcelain', { cwd: repoPath }, (gitErr, gitStdout) => {
                    if (!gitErr) {
                        hasChanges = gitStdout.trim().length > 0
                        logger.info('Git changes check', { hasChanges, statusOutput: gitStdout.trim() })
                    } else {
                        logger.error('Error checking git status:', gitErr)
                        hasChanges = true // Assume changes if we can't check
                    }
                    
                    resolve({
                        success,
                        output: output || '',
                        hasChanges
                    })
                })
                return
            }
            
            const fullOutput = success ? output : errorOutput || output
            
            resolve({
                success,
                output: fullOutput,
                hasChanges
            })
        })

        // Handle process errors
        janitoProcess.on('error', (error) => {
            logger.error('Janito process error:', error)
            resolve({
                success: false,
                output: `Process error: ${error.message}`,
                hasChanges: false
            })
        })
    })
}

// New function to generate 3 different progress messages
async function generateProgressMessages(janitoOutput: string): Promise<string[]> {
    const messages: string[] = []
    
    // Split output into chunks for different perspectives
    const lines = janitoOutput.split('\n').filter(line => line.trim().length > 0)
    const totalLines = lines.length
    
    if (totalLines === 0) return ['🤖 Processing your request...']
    
    // Generate 3 different messages focusing on different parts/aspects
    const chunk1 = lines.slice(0, Math.ceil(totalLines / 3)).join('\n')
    const chunk2 = lines.slice(Math.ceil(totalLines / 3), Math.ceil(2 * totalLines / 3)).join('\n')
    const chunk3 = lines.slice(Math.ceil(2 * totalLines / 3)).join('\n')
    
    try {
        // Message 1: Early progress
        if (chunk1.trim()) {
            const msg1 = await synthesizeProgressMessage([chunk1], 'janito_progress')
            messages.push(`🚀 ${msg1}`)
        }
        
        // Message 2: Mid progress
        if (chunk2.trim()) {
            const msg2 = await synthesizeProgressMessage([chunk2], 'janito_progress')
            messages.push(`⚡ ${msg2}`)
        }
        
        // Message 3: Final progress
        if (chunk3.trim()) {
            const msg3 = await synthesizeProgressMessage([chunk3], 'janito_progress')
            messages.push(`✅ ${msg3}`)
        }
        
        // If we don't have 3 messages, generate them from the full output with different prompts
        if (messages.length < 3) {
            const fullMessage = await synthesizeProgressMessage([janitoOutput], 'janito_progress')
            
            if (messages.length === 0) {
                messages.push(`🔧 Starting: ${fullMessage}`)
                messages.push(`⚡ Processing: ${fullMessage}`)
                messages.push(`✅ Completed: ${fullMessage}`)
            } else if (messages.length === 1) {
                messages.push(`⚡ Continuing: ${fullMessage}`)
                messages.push(`✅ Finished: ${fullMessage}`)
            } else if (messages.length === 2) {
                messages.push(`✅ Done: ${fullMessage}`)
            }
        }
        
    } catch (error) {
        logger.error('Error generating progress messages:', error)
        return ['🤖 Working on your request...', '⚡ Making progress...', '✅ Almost done...']
    }
    
    return messages.slice(0, 3) // Ensure we only return 3 messages
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

        // Handle audio messages first
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
        logger.info('Phone check detailed', { 
            senderJid, 
            remoteJid,
            participant: message.key.participant,
            phoneRaw: senderJid.split('@')[0],
            phone, 
            allowedPhones: config.allowedPhones,
            allowedPhonesLength: config.allowedPhones.length,
            includes: config.allowedPhones.includes(phone),
            allowedPhonesType: typeof config.allowedPhones,
            phoneType: typeof phone
        })
        if (!config.allowedPhones.includes(phone)) {
            logger.info('Phone not allowed, ignoring message', { phone, allowedPhones: config.allowedPhones })
            return
        }
        logger.info('Phone allowed, processing message', { phone })

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

*Getting started:*
1. Send me your GitHub token or use \`/auth <token>\`
2. Use \`/repos\` to see your repositories
3. Say "clone X repo" or use \`/clone <url>\`
4. Use \`/vibe <what you want>\` to edit code
5. Commit with intelligent messages! 

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
                    // Index with janito and synthesize description
                    exec(`cd ${localPath} && janito describe`, async (err, stdout, stderr) => {
                        if (err) {
                            const response = `Repo cloned but couldn't analyze it: ${stderr || err}`
                            await sock.sendMessage(remoteJid, { text: response })
                            addToHistory(remoteJid, 'assistant', response)
                        } else {
                            try {
                                // Synthesize the janito describe output
                                const rawDescription = stdout && stdout.trim().length > 0 
                                    ? stdout.trim() 
                                    : "Repository cloned successfully"
                                
                                const synthesizedDesc = await synthesizeProgressMessage([rawDescription], 'janito_describe')
                                const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'repository'
                                const response = `${repoName} is ready!\n\n${synthesizedDesc}\n\nTry "/vibe <task>" to start editing!`
                                
                                await sock.sendMessage(remoteJid, { text: response })
                                addToHistory(remoteJid, 'assistant', response)
                            } catch (error) {
                                logger.error('Error synthesizing description:', error)
                                // Fallback to original description
                                const janitoDesc = stdout && stdout.trim().length > 0
                                    ? stdout.trim().substring(0, 1000)
                                    : "Repository ready to use"
                                const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'repository'
                                const response = `${repoName} cloned and ready!\n\n${janitoDesc}\n\nUse "/vibe <task>" to edit!`
                                await sock.sendMessage(remoteJid, { text: response })
                                addToHistory(remoteJid, 'assistant', response)
                            }
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
            await sock.sendMessage(remoteJid, { text: "Starting AI code editing..." })

            try {
                const result = await runJanitoWithProgress(sock, remoteJid, repoPath, promptForJanito)
                
                if (result.success) {
                    if (result.hasChanges) {
                        userState[remoteJid] = { repoPath, waitingForCommit: true, lastPrompt: promptForJanito }
                        
                        const funnyCommitMessages = [
                            `Done! Want me to commit this masterpiece?`,
                            `All set! Should I save this work to git?`,
                            `Task completed! Ready to commit these changes?`,
                            `Boom! Code is ready. Commit time?`,
                            `Mission accomplished! Shall we make it official with a commit?`
                        ]
                        const randomMessage = funnyCommitMessages[Math.floor(Math.random() * funnyCommitMessages.length)]
                        
                        await sock.sendMessage(remoteJid, { 
                            text: `✅ AI editing completed!\n\n${randomMessage} (yes/no)` 
                        })
                        addToHistory(remoteJid, 'assistant', `✅ AI editing completed!\n\n${randomMessage} (yes/no)`)
                    } else {
                        const noChangesMessages = [
                            `Hmm, looks like everything was already perfect! No changes needed.`,
                            `I checked the code but didn't find anything to change. You're all good!`,
                            `Your code is already on point! Nothing to modify here.`,
                            `Seems like the task was already done. No changes required!`,
                            `Everything looks great as it is. No modifications needed.`
                        ]
                        const randomNoChangeMessage = noChangesMessages[Math.floor(Math.random() * noChangesMessages.length)]
                        
                        await sock.sendMessage(remoteJid, { text: `${randomNoChangeMessage}` })
                        addToHistory(remoteJid, 'assistant', `${randomNoChangeMessage}`)
                    }
                } else {
                    const errorMessages = [
                        `Oops, ran into some trouble:`,
                        `Hit a snag while working on that:`,
                        `Something went wrong on my end:`,
                        `Encountered an issue:`,
                        `Had some difficulty with that request:`
                    ]
                    const randomErrorMessage = errorMessages[Math.floor(Math.random() * errorMessages.length)]
                    
                    const response = `❌ AI editing failed:\n\n${result.output}`
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                }
            } catch (error) {
                logger.error('Error running janito with progress:', error)
                const response = `❌ Error during AI editing: ${error}`
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
            }

            return;
        }

        // 3. If waiting for commit confirmation
        if (userState[remoteJid]?.waitingForCommit) {
            if (/^(yes|commit)/i.test(textContent.trim())) {
                const repoPath = userState[remoteJid].repoPath
                const lastPrompt = userState[remoteJid].lastPrompt || 'AI-generated changes'
                const git = simpleGit(repoPath)
                await git.add('.')
                
                // Generate intelligent commit message
                const commitMessage = await generateCommitMessage(repoPath, lastPrompt)
                logger.info('Generated commit message', { commitMessage, prompt: lastPrompt })
                await git.commit(commitMessage)
                
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
                        
                        const successMessages = [
                            `Sweet! Committed and pushed: "${commitMessage}"`,
                            `All done! Pushed with: "${commitMessage}"`,
                            `Perfect! Your changes are live: "${commitMessage}"`,
                            `Boom! Code is on GitHub: "${commitMessage}"`,
                            `Nice! Everything's pushed: "${commitMessage}"`
                        ]
                        const randomSuccess = successMessages[Math.floor(Math.random() * successMessages.length)]
                        
                        await sock.sendMessage(remoteJid, { text: randomSuccess })
                        addToHistory(remoteJid, 'assistant', randomSuccess)
                    } else {
                        const localMessages = [
                            `Committed locally: "${commitMessage}"\n\nSet up a GitHub token with /auth to push!`,
                            `Saved your work: "${commitMessage}"\n\nAdd a token to push to GitHub.`,
                            `Changes committed: "${commitMessage}"\n\nNeed a GitHub token to push this live.`
                        ]
                        const randomLocal = localMessages[Math.floor(Math.random() * localMessages.length)]
                        
                        await sock.sendMessage(remoteJid, { text: randomLocal })
                        addToHistory(remoteJid, 'assistant', randomLocal)
                    }
                } catch (pushErr) {
                    logger.error('Git push failed', pushErr)
                    const response = `Committed: "${commitMessage}"\n\nBut couldn't push - ${pushErr}`
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                }
                userState[remoteJid].waitingForCommit = false
            } else {
                userState[remoteJid].waitingForCommit = false
                const cancelMessages = [
                    "No worries! Your changes are still there if you change your mind.",
                    "Got it, keeping the changes uncommitted for now.",
                    "Fair enough! The code's ready when you are.",
                    "Okay, leaving things as they are for now."
                ]
                const randomCancel = cancelMessages[Math.floor(Math.random() * cancelMessages.length)]
                
                await sock.sendMessage(remoteJid, { text: randomCancel })
                addToHistory(remoteJid, 'assistant', randomCancel)
            }
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
                        
                        const startResponse = `Cloning ${foundRepo.name}...`
                        await sock.sendMessage(remoteJid, { text: startResponse })
                        addToHistory(remoteJid, 'assistant', startResponse)

                        simpleGit().clone(foundRepo.clone_url, localPath)
                            .then(async () => {
                                addRepo(remoteJid, foundRepo.clone_url, localPath)
                                exec(`cd ${localPath} && janito describe`, async (err, stdout, stderr) => {
                                    if (err) {
                                        const response = `Repo cloned but couldn't analyze it: ${stderr || err}`
                                        await sock.sendMessage(remoteJid, { text: response })
                                        addToHistory(remoteJid, 'assistant', response)
                                    } else {
                                        try {
                                            const rawDescription = stdout && stdout.trim().length > 0 
                                                ? stdout.trim() 
                                                : "Repository cloned successfully"
                                            
                                            const synthesizedDesc = await synthesizeProgressMessage([rawDescription], 'janito_describe')
                                            const response = `${foundRepo.name} is ready!\n\n${synthesizedDesc}\n\nTry "/vibe <task>" to start editing!`
                                            
                                            await sock.sendMessage(remoteJid, { text: response })
                                            addToHistory(remoteJid, 'assistant', response)
                                        } catch (error) {
                                            logger.error('Error synthesizing description:', error)
                                            const janitoDesc = stdout && stdout.trim().length > 0
                                                ? stdout.trim().substring(0, 1000)
                                                : "Repository ready to use"
                                            const response = `${foundRepo.name} cloned and ready!\n\n${janitoDesc}\n\nUse "/vibe <task>" to edit!`
                                            await sock.sendMessage(remoteJid, { text: response })
                                            addToHistory(remoteJid, 'assistant', response)
                                        }
                                    }
                                })
                            })
                            .catch(async (err) => {
                                const response = `Failed to clone ${foundRepo.name}: ${err}`
                                await sock.sendMessage(remoteJid, { text: response })
                                addToHistory(remoteJid, 'assistant', response)
                            })
                        return
                    } else {
                        const response = `Repository "${repoName}" not found in your GitHub repos.\n\nUse /repos to see available repositories.`
                        await sock.sendMessage(remoteJid, { text: response })
                        addToHistory(remoteJid, 'assistant', response)
                        return
                    }
                } else {
                    const response = `No GitHub repositories cached. Use /repos first to load your repositories.`
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                    return
                }
            }
        }

        // AI fallback
        try {
            logger.info('Entering AI fallback', { textContent, aiEnabled: config.bot.aiEnabled })
            if (config.bot.aiEnabled) {
                const history = conversationHistory[remoteJid] || []
                const cachedGithubRepos = githubReposCache[remoteJid] || []
                
                const isRepoQuestion = /(?:repo|repositor)/i.test(textContent)
                if (isRepoQuestion && cachedGithubRepos.length === 0 && getToken(remoteJid)) {
                    const response = "I don't have your GitHub repositories cached yet. Use `/repos` first to load them!"
                    await sock.sendMessage(remoteJid, { text: response })
                    addToHistory(remoteJid, 'assistant', response)
                    return
                }
                
                const response = await chatWithRepoFunctions(remoteJid, textContent, history, cachedGithubRepos)
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

// Extract the core message handling logic to be reusable by audioHandler
export async function processTextMessage(sock: WASocket, remoteJid: string, textContent: string, fromAudio: boolean = false) {
    const prefix = fromAudio ? '🎤➡️ ' : ''
    
    // Add user message to history
    addToHistory(remoteJid, 'user', textContent)

    // Auto-detect GitHub token in any message
    const detectedToken = detectGitHubToken(textContent)
    if (detectedToken) {
        logger.info('GitHub token detected', { tokenLength: detectedToken.length, tokenStart: detectedToken.substring(0, 10) })
        saveToken(remoteJid, detectedToken)
        logger.info('Token saved for user', { remoteJid })
        const response = `${prefix}GitHub token detected and saved! You can now use repo commands.`
        await sock.sendMessage(remoteJid, { text: response })
        addToHistory(remoteJid, 'assistant', response)
        return
    }

    // Handle /vibe command
    if (textContent.startsWith('/vibe ')) {
        const activeRepo = getActiveRepo(remoteJid)
        if (!activeRepo) {
            const response = `${prefix}No active repository. Use /repos to list or /clone to add repositories.`
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
            return
        }

        const repoPath = activeRepo.localPath
        const promptForJanito = textContent.replace('/vibe', '').trim()

        if (!promptForJanito) {
            const response = `${prefix}Please provide a prompt, e.g., /vibe Change the title to Hello World.`
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
            return
        }

        logger.info(`Running janito for prompt: ${promptForJanito} on ${repoPath}`)
        await sock.sendMessage(remoteJid, { text: `${prefix}Starting AI code editing...` })

        try {
            const result = await runJanitoWithProgress(sock, remoteJid, repoPath, promptForJanito)
            
            if (result.success) {
                if (result.hasChanges) {
                    userState[remoteJid] = { repoPath, waitingForCommit: true, lastPrompt: promptForJanito }
                    
                    const funnyCommitMessages = [
                        `Done! Want me to commit this masterpiece?`,
                        `All set! Should I save this work to git?`,
                        `Task completed! Ready to commit these changes?`,
                        `Boom! Code is ready. Commit time?`,
                        `Mission accomplished! Shall we make it official with a commit?`
                    ]
                    const randomMessage = funnyCommitMessages[Math.floor(Math.random() * funnyCommitMessages.length)]
                    
                    await sock.sendMessage(remoteJid, { 
                        text: `${prefix}${randomMessage} (yes/no)` 
                    })
                    addToHistory(remoteJid, 'assistant', `${prefix}${randomMessage} (yes/no)`)
                } else {
                    const noChangesMessages = [
                        `Hmm, looks like everything was already perfect! No changes needed.`,
                        `I checked the code but didn't find anything to change. You're all good!`,
                        `Your code is already on point! Nothing to modify here.`,
                        `Seems like the task was already done. No changes required!`,
                        `Everything looks great as it is. No modifications needed.`
                    ]
                    const randomNoChangeMessage = noChangesMessages[Math.floor(Math.random() * noChangesMessages.length)]
                    
                    await sock.sendMessage(remoteJid, { text: `${prefix}${randomNoChangeMessage}` })
                    addToHistory(remoteJid, 'assistant', `${prefix}${randomNoChangeMessage}`)
                }
            } else {
                const errorMessages = [
                    `Oops, ran into some trouble:`,
                    `Hit a snag while working on that:`,
                    `Something went wrong on my end:`,
                    `Encountered an issue:`,
                    `Had some difficulty with that request:`
                ]
                const randomErrorMessage = errorMessages[Math.floor(Math.random() * errorMessages.length)]
                
                const response = `${prefix}${randomErrorMessage}\n\n${result.output}`
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
            }
        } catch (error) {
            logger.error('Error running janito with progress:', error)
            const response = `${prefix}Sorry, something unexpected happened while processing your request.`
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
        }
        return
    }

    // Handle other commands (repos, clone, etc.) - simplified version for audio
    if (textContent.startsWith('/repos') || textContent.toLowerCase().includes('repositorios') || textContent.toLowerCase().includes('repos')) {
        try {
            const token = getToken(remoteJid)
            if (!token) {
                const response = `${prefix}You'll need to set up your GitHub token first. Try /auth <token>`
                await sock.sendMessage(remoteJid, { text: response })
                addToHistory(remoteJid, 'assistant', response)
                return
            }

            const loadingMessages = [
                `${prefix}Getting your repositories...`,
                `${prefix}Fetching your GitHub repos...`,
                `${prefix}Loading your projects...`,
                `${prefix}Checking what you've got...`
            ]
            const randomLoadingMessage = loadingMessages[Math.floor(Math.random() * loadingMessages.length)]
            
            await sock.sendMessage(remoteJid, { text: randomLoadingMessage })
            addToHistory(remoteJid, 'assistant', randomLoadingMessage)

            const githubRepos = await fetchUserRepos(token)
            const localRepos = listRepos(remoteJid)
            
            // Cache GitHub repos for context
            githubReposCache[remoteJid] = githubRepos
            
            // Show repos with simple format
            let response = `${prefix}Here's what you've got:\n\n`
            githubRepos.slice(0, 10).forEach(repo => {
                const isLocal = localRepos.some(local => local.repoUrl === repo.clone_url)
                const localIcon = isLocal ? ' (local)' : ''
                const privateIcon = repo.private ? '[private] ' : ''
                const lang = repo.language ? ` [${repo.language}]` : ''
                const activeIcon = isLocal && getActiveRepo(remoteJid)?.repoUrl === repo.clone_url ? ' ★' : ''
                
                response += `${privateIcon}${repo.name}${lang}${localIcon}${activeIcon}\n`
            })
            
            const cloneables = githubRepos.filter(repo => 
                !localRepos.some(local => local.repoUrl === repo.clone_url)
            ).slice(0, 3)
            
            if (cloneables.length > 0) {
                response += `\nWant to clone something? Try: "${cloneables[0].name}"`
            }
            
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
        } catch (error) {
            logger.error('Error fetching GitHub repos', error)
            const response = `${prefix}Couldn't fetch your repos right now. Check your token maybe?`
            await sock.sendMessage(remoteJid, { text: response })
            addToHistory(remoteJid, 'assistant', response)
        }
        return
    }

    // For other commands, fall back to AI or show suggestion
    const helpfulMessages = [
        `${prefix}I get that you want to: "${textContent}"`,
        `${prefix}Understood: "${textContent}"`,
        `${prefix}Got it: "${textContent}"`
    ]
    const randomHelpMessage = helpfulMessages[Math.floor(Math.random() * helpfulMessages.length)]
    
    const response = `${randomHelpMessage}\n\nNeed help? Try:\n• /repos - Your repositories\n• /vibe <task> - Edit code\n• /status - Current repo status`
    await sock.sendMessage(remoteJid, { text: response })
    addToHistory(remoteJid, 'assistant', response)
}
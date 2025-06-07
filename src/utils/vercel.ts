import { exec, execSync } from 'child_process'
import { createLogger } from '../logger/index.js'
import fs from 'fs'
import path from 'path'

const logger = createLogger('VercelUtils')

export interface VercelDeploymentResult {
    success: boolean
    url?: string
    message: string
    logs?: string
}

export interface VercelStatusResult {
    success: boolean
    deployments: Array<{
        url: string
        age: string
        state?: string
    }>
    message: string
}

export function isVercelCliInstalled(): boolean {
    try {
        execSync('which vercel', { stdio: 'ignore' })
        return true
    } catch (error) {
        return false
    }
}

export function isVercelProject(projectPath: string): boolean {
    const vercelDir = path.join(projectPath, '.vercel')
    const vercelJson = path.join(projectPath, 'vercel.json')
    return fs.existsSync(vercelDir) || fs.existsSync(vercelJson)
}

export function deployToVercel(projectPath: string, isProduction = true, token?: string): Promise<VercelDeploymentResult> {
    return new Promise((resolve) => {
        // Build command with token flag if available
        let deployCmd = `cd ${projectPath}`
        
        if (token) {
            // Use the --token flag directly (more reliable than env var)
            deployCmd += ` && vercel${isProduction ? ' --prod' : ''} --yes --token="${token}"`
        } else {
            deployCmd += ` && vercel${isProduction ? ' --prod' : ''} --yes`
        }
        
        logger.info('Starting Vercel deployment', { projectPath, isProduction, hasToken: !!token, command: deployCmd.replace(token || '', '[REDACTED]') })
        
        // Add timeout to prevent hanging
        const childProcess = exec(deployCmd, { timeout: 300000 }, (err, stdout, stderr) => {
            if (err) {
                logger.error('Vercel deployment failed', { error: err, stderr })
                
                // Check for timeout specifically
                if (err.message.includes('timeout') || err.signal === 'SIGTERM') {
                    resolve({
                        success: false,
                        message: '⏱️ **Deployment Timed Out** (5 min)\n\nThis might mean:\n• Large project taking time to build\n• Network issues\n• Vercel service delays\n\nTry `/vercel-status` to check if it completed.',
                        logs: stderr
                    })
                    return
                }
                
                // Check for common authentication errors
                if (err.message.includes('not authenticated') || 
                    stderr.includes('not authenticated') ||
                    stderr.includes('invalid token') ||
                    stderr.includes('unauthorized') ||
                    err.message.includes('401') ||
                    err.message.includes('403')) {
                    resolve({
                        success: false,
                        message: '🔐 **Authentication Failed**\n\nPlease:\n1. Get fresh token: https://vercel.com/account/tokens\n2. Use `/vercel-token <new_token>`\n3. Ensure token has proper permissions',
                        logs: stderr
                    })
                    return
                }
                
                // Parse Vercel-specific errors
                let message = '❌ **Deployment Failed**\n\n'
                
                // Extract URLs if deployment started but failed
                const urlMatches = stderr.match(/https:\/\/[^\s]+\.vercel\.app/g)
                if (urlMatches && urlMatches.length > 0) {
                    message += `🔍 **Inspect URL:**\n${urlMatches[0]}\n\n`
                }
                
                // Extract build errors
                if (stderr.includes('npm run build') && stderr.includes('exited with 1')) {
                    message += '🔨 **Build Error:**\nYour project failed to build\n\n'
                    
                    // Try to extract the actual error
                    const errorLines = stderr.split('\n')
                    for (let i = 0; i < errorLines.length; i++) {
                        const line = errorLines[i]
                        if (line.includes('Error:') && !line.includes('Command failed')) {
                            message += `💡 **Issue:** ${line.replace('Error:', '').trim()}\n\n`
                            break
                        }
                    }
                    
                    message += '**Next Steps:**\n'
                    message += '• Check your build script in `package.json`\n'
                    message += '• Fix any TypeScript/compilation errors\n'
                    message += '• Test locally: `npm run build`'
                } else if (stderr.includes('ENOENT') || stderr.includes('not found')) {
                    message += '📁 **Missing Files:**\nSome required files or dependencies are missing\n\n'
                    message += '**Try:**\n• `npm install` to install dependencies\n• Check if all files are committed to git'
                } else {
                    // Generic error - show first meaningful line
                    const errorLines = stderr.split('\n').filter(line => 
                        line.trim() && 
                        !line.includes('Command failed') &&
                        !line.includes('Vercel CLI')
                    )
                    
                    if (errorLines.length > 0) {
                        message += `💭 **Error:** ${errorLines[0].trim()}\n\n`
                    }
                    
                    message += '**Debug:**\n• Use `/vercel-logs` for details\n• Check Vercel dashboard'
                }
                
                resolve({
                    success: false,
                    message,
                    logs: stderr
                })
            } else {
                // Extract deployment URL from stdout
                const urlMatch = stdout.match(/https:\/\/[^\s]+\.vercel\.app/g)
                const deploymentUrl = urlMatch ? urlMatch[urlMatch.length - 1] : undefined
                
                logger.info('Vercel deployment successful', { deploymentUrl, projectPath })
                
                let message = '✅ **Deployment Successful!** 🎉\n\n'
                if (deploymentUrl) {
                    message += `🌐 **Live URL:**\n${deploymentUrl}\n\n`
                }
                
                // Extract build time if available
                const buildTimeMatch = stdout.match(/\[(\d+)ms\]/)
                if (buildTimeMatch) {
                    const buildTime = Math.round(parseInt(buildTimeMatch[1]) / 1000)
                    message += `⏱️ Built in ${buildTime}s`
                } else {
                    message += `🚀 Your project is now live!`
                }
                
                resolve({
                    success: true,
                    url: deploymentUrl,
                    message,
                    logs: stdout
                })
            }
        })
        
        // Add progress updates for long deployments
        let progressTimer: NodeJS.Timeout
        let progressCount = 0
        
        if (childProcess.pid) {
            progressTimer = setInterval(() => {
                progressCount++
                const dots = '.'.repeat((progressCount % 3) + 1)
                logger.info(`Deployment in progress${dots}`, { elapsed: `${progressCount * 30}s` })
            }, 30000) // Every 30 seconds
        }
        
        // Clean up timer when process ends
        childProcess.on('exit', () => {
            if (progressTimer) {
                clearInterval(progressTimer)
            }
        })
    })
}

export function getVercelStatus(projectPath: string, token?: string): Promise<VercelStatusResult> {
    return new Promise((resolve) => {
        // Build command with token flag if available
        let statusCmd = `cd ${projectPath}`
        
        if (token) {
            statusCmd += ` && vercel ls --token="${token}"`
        } else {
            statusCmd += ` && vercel ls`
        }
        
        logger.info('Checking Vercel status', { projectPath, hasToken: !!token })
        
        exec(statusCmd, (err, stdout, stderr) => {
            if (err) {
                logger.error('Failed to get Vercel status', { error: err, stderr })
                
                let message = `❌ Failed to check status: ${err.message}`
                if (stderr) {
                    message += `\n\nDetails: ${stderr}`
                }
                
                // Check for common authentication errors
                if (err.message.includes('not authenticated') || 
                    stderr.includes('not authenticated') ||
                    stderr.includes('invalid token') ||
                    stderr.includes('unauthorized') ||
                    err.message.includes('401') ||
                    err.message.includes('403')) {
                    message += '\n\n💡 Authentication failed. Please:\n1. Get a fresh token from https://vercel.com/account/tokens\n2. Use `/vercel-token <your_new_token>` to save it\n3. Make sure the token has the right scope/permissions'
                }
                
                resolve({
                    success: false,
                    deployments: [],
                    message
                })
            } else {
                const lines = stdout.split('\n').filter(line => line.trim())
                
                if (lines.length < 2) {
                    resolve({
                        success: true,
                        deployments: [],
                        message: '📝 No deployments found for this project.\n\nUse `/deploy` to create your first deployment!'
                    })
                } else {
                    const deployments: Array<{
                        url: string
                        age: string
                        state?: string
                    }> = []
                    
                    // Parse deployment lines (skip header)
                    for (let i = 1; i < lines.length; i++) {
                        const line = lines[i].trim()
                        if (line) {
                            const parts = line.split(/\s+/)
                            if (parts.length >= 2) {
                                deployments.push({
                                    url: `https://${parts[1]}`,
                                    age: parts[parts.length - 1],
                                    state: parts.length > 3 ? parts[2] : undefined
                                })
                            }
                        }
                    }
                    
                    const latestDeployment = deployments[0]
                    let message = '📊 **Deployment Status**\n\n'
                    
                    if (latestDeployment) {
                        // Determine status icon and message
                        const state = latestDeployment.state || 'READY'
                        let statusIcon = '✅'
                        let statusText = 'Ready'
                        let statusColor = ''
                        
                        switch (state.toUpperCase()) {
                            case 'BUILDING':
                                statusIcon = '🔨'
                                statusText = 'Building'
                                statusColor = '🟡'
                                break
                            case 'QUEUED':
                                statusIcon = '⏳'
                                statusText = 'Queued'
                                statusColor = '🟠'
                                break
                            case 'FAILED':
                            case 'ERROR':
                                statusIcon = '❌'
                                statusText = 'Failed'
                                statusColor = '🔴'
                                break
                            case 'READY':
                            case 'COMPLETED':
                                statusIcon = '✅'
                                statusText = 'Live'
                                statusColor = '🟢'
                                break
                            default:
                                statusIcon = '❓'
                                statusText = state
                                statusColor = '⚪'
                        }
                        
                        message += `${statusColor} **Status:** ${statusIcon} ${statusText}\n\n`
                        message += `🌐 **URL:**\n${latestDeployment.url}\n\n`
                        message += `⏰ **Updated:** ${latestDeployment.age}\n`
                        message += `📈 **Total:** ${deployments.length} deployments`
                        
                        // Add helpful action based on status
                        if (state.toUpperCase() === 'BUILDING') {
                            message += '\n\n💡 Still building... check back in a few minutes'
                        } else if (state.toUpperCase() === 'FAILED') {
                            message += '\n\n💡 Use `/vercel-logs` to see error details'
                        } else if (state.toUpperCase() === 'QUEUED') {
                            message += '\n\n💡 Deployment is waiting in queue'
                        }
                    }
                    
                    resolve({
                        success: true,
                        deployments,
                        message
                    })
                }
            }
        })
    })
}

export function getVercelLogs(projectPath: string, limit = 50, token?: string): Promise<{ success: boolean; logs: string; message: string }> {
    return new Promise((resolve) => {
        // Build command with token flag if available
        let logsCmd = `cd ${projectPath}`
        
        if (token) {
            logsCmd += ` && vercel logs --limit=${limit} --token="${token}"`
        } else {
            logsCmd += ` && vercel logs --limit=${limit}`
        }
        
        logger.info('Fetching Vercel logs', { projectPath, limit, hasToken: !!token })
        
        exec(logsCmd, (err, stdout, stderr) => {
            if (err) {
                logger.error('Failed to get Vercel logs', { error: err, stderr })
                
                let message = `❌ Failed to fetch logs: ${err.message}`
                if (stderr) {
                    message += `\n\nDetails: ${stderr}`
                }
                
                // Check for common authentication errors
                if (err.message.includes('not authenticated') || 
                    stderr.includes('not authenticated') ||
                    stderr.includes('invalid token') ||
                    stderr.includes('unauthorized') ||
                    err.message.includes('401') ||
                    err.message.includes('403')) {
                    message += '\n\n💡 Authentication failed. Please:\n1. Get a fresh token from https://vercel.com/account/tokens\n2. Use `/vercel-token <your_new_token>` to save it\n3. Make sure the token has the right scope/permissions'
                }
                
                resolve({
                    success: false,
                    logs: stderr || '',
                    message
                })
            } else {
                let message = `📜 Recent Deployment Logs:\n\n${stdout}`
                
                // Truncate if too long for WhatsApp
                if (message.length > 4000) {
                    message = message.substring(0, 4000) + '\n\n... (truncated)\n\nUse Vercel dashboard for full logs.'
                }
                
                resolve({
                    success: true,
                    logs: stdout,
                    message
                })
            }
        })
    })
}

export function detectProjectType(projectPath: string): string | null {
    const packageJsonPath = path.join(projectPath, 'package.json')
    
    if (!fs.existsSync(packageJsonPath)) {
        return null
    }
    
    try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
        
        // Check for common frameworks
        const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }
        
        if (dependencies.next) return 'Next.js'
        if (dependencies.react) return 'React'
        if (dependencies.vue || dependencies['@vue/cli-service']) return 'Vue.js'
        if (dependencies.angular || dependencies['@angular/core']) return 'Angular'
        if (dependencies.svelte) return 'Svelte'
        if (dependencies.gatsby) return 'Gatsby'
        if (dependencies.nuxt) return 'Nuxt.js'
        if (dependencies.express) return 'Express.js'
        
        return 'Node.js'
    } catch (error) {
        logger.warn('Failed to parse package.json', { projectPath, error })
        return null
    }
}

export function generateVercelJson(projectPath: string, projectType: string): boolean {
    const vercelJsonPath = path.join(projectPath, 'vercel.json')
    
    if (fs.existsSync(vercelJsonPath)) {
        return false // Already exists
    }
    
    let config: any = {
        version: 2
    }
    
    switch (projectType) {
        case 'Next.js':
            // Next.js has built-in Vercel support
            break
        case 'React':
            config.builds = [
                {
                    src: 'package.json',
                    use: '@vercel/static-build',
                    config: { distDir: 'build' }
                }
            ]
            break
        case 'Vue.js':
            config.builds = [
                {
                    src: 'package.json',
                    use: '@vercel/static-build',
                    config: { distDir: 'dist' }
                }
            ]
            break
        case 'Express.js':
            config.functions = {
                'api/*.js': {
                    runtime: 'nodejs18.x'
                }
            }
            break
        default:
            // Default static build
            config.builds = [
                {
                    src: 'package.json',
                    use: '@vercel/static-build'
                }
            ]
    }
    
    try {
        fs.writeFileSync(vercelJsonPath, JSON.stringify(config, null, 2))
        logger.info('Generated vercel.json', { projectPath, projectType })
        return true
    } catch (error) {
        logger.error('Failed to generate vercel.json', { projectPath, error })
        return false
    }
}

export function validateVercelToken(token: string): boolean {
    // Basic token format validation
    if (!token || typeof token !== 'string') {
        return false
    }
    
    // Remove whitespace
    token = token.trim()
    
    // Check minimum length (Vercel tokens are typically 40+ characters)
    if (token.length < 20) {
        return false
    }
    
    // Check for obvious invalid patterns
    if (token.includes(' ') || token.includes('\n') || token.includes('\t')) {
        return false
    }
    
    return true
}

export async function testVercelToken(token: string): Promise<{ valid: boolean; message: string }> {
    if (!validateVercelToken(token)) {
        return {
            valid: false,
            message: 'Token format appears invalid. Tokens should be 20+ characters with no spaces.'
        }
    }
    
    return new Promise((resolve) => {
        // Test token with a simple whoami command
        const testCmd = `vercel whoami --token="${token}"`
        
        logger.info('Testing Vercel token validity')
        
        exec(testCmd, (err, stdout, stderr) => {
            if (err) {
                logger.error('Token test failed', { error: err, stderr })
                
                if (err.message.includes('not authenticated') || 
                    stderr.includes('not authenticated') ||
                    stderr.includes('invalid token') ||
                    stderr.includes('unauthorized') ||
                    err.message.includes('401') ||
                    err.message.includes('403')) {
                    resolve({
                        valid: false,
                        message: 'Token is invalid or expired. Please create a new token.'
                    })
                } else {
                    resolve({
                        valid: false,
                        message: `Token test failed: ${err.message}`
                    })
                }
            } else {
                const username = stdout.trim()
                resolve({
                    valid: true,
                    message: `Token is valid! Authenticated as: ${username}`
                })
            }
        })
    })
} 
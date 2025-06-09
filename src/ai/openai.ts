import OpenAI from 'openai'
import { config } from '../config/index.js'
import { listRepos, getActiveRepo } from '../db/index.js'

let client: OpenAI | null = null

if (config.ai.apiKey) {
    client = new OpenAI({ apiKey: config.ai.apiKey })
}

export async function generateResponse(prompt: string): Promise<string> {
    if (!client) {
        throw new Error('OpenAI API key is missing. Set OPENAI_API_KEY to enable AI responses.')
    }

    const messages: { role: 'system' | 'user'; content: string }[] = []
    if (config.ai.systemPrompt) {
        messages.push({ role: 'system', content: config.ai.systemPrompt })
    }
    messages.push({ role: 'user', content: prompt })

    const chat = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages
    })

    return chat.choices[0]?.message?.content?.trim() || ''
}

export async function chatWithRepoFunctions(phone: string, prompt: string, history?: Array<{ role: 'user' | 'assistant', content: string }>, githubRepos?: any[]): Promise<string> {
    if (!client) {
        throw new Error('OpenAI API key is missing.')
    }

    const functions = [
        {
            name: 'get_active_repos',
            description: 'Return list of locally cloned repositories for the user',
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'get_github_repos',
            description: 'Return list of all GitHub repositories for the user',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    ]

    const systemPrompt = `You are Buddy, an AI coding assistant that helps developers manage and edit Git repositories via WhatsApp.

 CONTEXT: You can help users with:
 - Managing GitHub repositories (clone, list, switch between repos)
 - Code editing and generation
 - Git operations (commit, push with their GitHub tokens)
 - General programming questions

 IMPORTANT: 
 - Be concise but helpful (WhatsApp messages should be short)
 - If you detect sensitive information like tokens or keys in messages, remind users about security
 - Always use function calls when you need repository information
 - Be conversational and friendly
 - When users ask about repositories (e.g., "que repos tengo?", "what repos do I have?", "show my repositories"), ALWAYS call get_github_repos first
 - If they ask about local/cloned repos specifically, use get_active_repos
 - Use get_github_repos for general repository questions

 When users say "clone X repo" or similar, help them identify which repository they mean
 Use get_github_repos to see all their GitHub repositories
 Use get_active_repos to see locally cloned repositories

 COMMANDS AVAILABLE:
 /auth <token> - Save GitHub token
 /clone <url> - Clone repository  
 /repos - List repositories
 /use <number> - Switch active repository
 /help - Show help and commands

 You can also understand natural language like "clone my-project" or "clona repo-name"`

    const messages: any[] = []
    
    // Add system prompt
    messages.push({ role: 'system', content: systemPrompt })
    
    // Add conversation history if provided
    if (history && history.length > 0) {
        // Only use last 10 messages to avoid token limits
        const recentHistory = history.slice(-10)
        messages.push(...recentHistory)
    }
    
    // Add current user message
    messages.push({ role: 'user', content: prompt })

    const chat = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        functions
    })

    console.log('🤖 OpenAI response:', {
        finishReason: chat.choices[0]?.finish_reason,
        hasFunction: !!chat.choices[0]?.message?.function_call,
        functionName: chat.choices[0]?.message?.function_call?.name
    })

    const first = chat.choices[0]
    if (first.finish_reason === 'function_call' && first.message?.function_call) {
        const functionName = first.message.function_call.name
        console.log('🔧 Function call detected:', functionName)
        
        if (functionName === 'get_active_repos') {
            console.log('📁 Getting local repos for:', phone)
            const repos = listRepos(phone).map((r) => ({ 
                id: r.id, 
                url: r.repoUrl, 
                path: r.localPath, 
                active: getActiveRepo(phone)?.id === r.id 
            }))
            console.log('📁 Local repos found:', repos.length)
            messages.push({
                role: 'function',
                name: 'get_active_repos',
                content: JSON.stringify(repos)
            })
        } else if (functionName === 'get_github_repos') {
            console.log('🐙 Getting GitHub repos for:', phone, 'Cached repos:', githubRepos?.length || 0)
            const repoData = githubRepos ? githubRepos.map(repo => ({
                name: repo.name,
                full_name: repo.full_name,
                description: repo.description,
                language: repo.language,
                private: repo.private,
                stars: repo.stargazers_count,
                clone_url: repo.clone_url,
                updated_at: repo.updated_at
            })) : []
            console.log('🐙 GitHub repos to send:', repoData.length)
            messages.push({
                role: 'function',
                name: 'get_github_repos',
                content: JSON.stringify(repoData)
            })
        }
        
        console.log('🔄 Making second API call...')
        const second = await client.chat.completions.create({ model: 'gpt-4o-mini', messages })
        console.log('✅ Second API call completed')
        return second.choices[0]?.message?.content?.trim() || ''
    }

    return first.message?.content?.trim() || ''
}

export async function analyzeAudioIntent(transcription: string, githubRepos?: any[]): Promise<{
    intent: 'command' | 'vibe' | 'general',
    extractedCommand?: string,
    vibePrompt?: string,
    originalTranscription: string,
    suggestedRepo?: any
}> {
    if (!client) {
        throw new Error('OpenAI API key is missing.')
    }

    const repoList = githubRepos ? githubRepos.map(repo => repo.name).join(', ') : 'No repos available'

    const systemPrompt = `You are an AI that analyzes voice transcriptions from a WhatsApp coding assistant.

Your job is to determine the user's intent from their voice message and extract the relevant information.

POSSIBLE INTENTS:
1. "command" - User wants to execute a specific command (like /repos, /clone, /status, /help, etc.)
2. "vibe" - User wants to edit code or make changes to a repository 
3. "general" - General conversation or questions

RULES:
- If user mentions repository operations (clone, list repos, switch repo, status), return "command"
- If user wants to edit, modify, change, add, fix, or improve code, return "vibe"
- If user asks general questions about programming or needs help, return "general"

SPECIAL HANDLING FOR CLONE REQUESTS:
- If user wants to clone a repository, try to match their requested repo name with available repositories
- Available repositories: ${repoList}
- Be flexible with matching (partial names, similar sounds, etc.)
- If you find a match, include the repository name in extractedCommand

EXAMPLES:
- "muéstrame mis repositorios" → command: "/repos"
- "clona mi proyecto backend" → command: "clone backend" (if 'backend' repo exists)
- "clona repo llamado buddy" → command: "clone buddy" (if 'buddy' repo exists)
- "cambia el título a Hello World" → vibe: "change the title to Hello World"
- "agrega un botón de login" → vibe: "add a login button"
- "qué es React?" → general

Return a JSON object with:
- intent: the detected intent
- extractedCommand: the command to execute (only for "command" intent)
- vibePrompt: the editing instruction (only for "vibe" intent)  
- originalTranscription: the original text
- suggestedRepo: the repository name if clone is requested and match found

IMPORTANT: Return ONLY the JSON object, no other text.`

    const messages: { role: 'system' | 'user'; content: string }[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcription }
    ]

    const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.1
    })

    try {
        const result = JSON.parse(response.choices[0]?.message?.content?.trim() || '{}')
        
        // If it's a clone command and we have repos, try fuzzy matching
        let suggestedRepo = null
        if (result.intent === 'command' && result.extractedCommand && 
            result.extractedCommand.toLowerCase().includes('clone') && githubRepos) {
            
            const cloneMatch = result.extractedCommand.match(/clone\s+(\w+)/i)
            if (cloneMatch) {
                const searchTerm = cloneMatch[1].toLowerCase()
                // Simple fuzzy search
                suggestedRepo = githubRepos.find(repo => 
                    repo.name.toLowerCase().includes(searchTerm) ||
                    searchTerm.includes(repo.name.toLowerCase()) ||
                    repo.name.toLowerCase().startsWith(searchTerm)
                )
            }
        }
        
        return {
            intent: result.intent || 'general',
            extractedCommand: result.extractedCommand,
            vibePrompt: result.vibePrompt,
            originalTranscription: transcription,
            suggestedRepo
        }
    } catch (error) {
        console.error('Error parsing AI intent response:', error)
        return {
            intent: 'general',
            originalTranscription: transcription
        }
    }
}

export async function synthesizeProgressMessage(messages: string[], context: 'janito_progress' | 'janito_describe'): Promise<string> {
    if (!client) {
        throw new Error('OpenAI API key is missing.')
    }

    const systemPrompt = context === 'janito_progress' 
        ? `Convert janito's console output into ONE clear WhatsApp progress update.

RULES:
- Return exactly ONE sentence describing current progress
- Focus on SPECIFIC actions: files being created/modified, functions added, components built
- Mention file names, functions, or components when available
- Be descriptive about the actual changes being made
- Keep it engaging but under 100 characters
- Don't mention questions, errors, or requests for input

EXAMPLES:

Input: "Discovery: Translating README to Hungarian... Creating file README.hu.md... Translation complete with minor formatting warning"
Output: "📝 Created Hungarian README translation (README.hu.md)"

Input: "Creating login component... Adding validation logic... Updating App.js imports... Component styling added to styles.css"
Output: "🔧 Built login component with validation, updated App.js and styles"

Input: "Analyzing 15 TypeScript files... Updating Header.tsx with new props... Footer.tsx modifications... Interface definitions added to types.ts"
Output: "⚡ Updated Header/Footer components and added new TypeScript interfaces"

Input: "Adding authentication middleware... Creating auth routes... Updating database schema... Tests added"
Output: "🔐 Built authentication system with middleware, routes, and database updates"

Input: "Refactoring API endpoints... Moving utils to separate files... Updating imports across 8 files"
Output: "🔄 Refactored API structure and reorganized utilities across 8 files"

Return ONLY one informative sentence with an emoji.`
        : `Explain what this codebase does in one sentence.

Return ONLY the explanation.`

    const messagesContent = messages.join('\n')
    
    const chatMessages: { role: 'system' | 'user'; content: string }[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: messagesContent }
    ]

    const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: chatMessages,
        temperature: 0.2, // Slightly more creative but still consistent
        max_tokens: 60,   // Bit more room for useful info
        presence_penalty: 0.6, // Moderate repetition avoidance
        frequency_penalty: 0.6 // Moderate repetition avoidance
    })

    const rawResponse = response.choices[0]?.message?.content?.trim() || 'Working on your request'
    
    // Gentle post-processing to ensure quality
    const singleMessage = rawResponse
        .split('\n')[0] // Take first line only
        .replace(/^["']|["']$/g, '') // Remove quotes if any
        .substring(0, 120) // Allow more characters for useful info
        .trim()
    
    return singleMessage || 'Processing your request'
}

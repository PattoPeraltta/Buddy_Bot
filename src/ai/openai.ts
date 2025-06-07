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

    const systemPrompt = `You are Commeta, an AI coding assistant that helps developers manage and edit Git repositories via WhatsApp.

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

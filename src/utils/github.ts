import axios from 'axios'

interface GitHubRepo {
    id: number
    name: string
    full_name: string
    html_url: string
    clone_url: string
    private: boolean
    description: string | null
    language: string | null
    stargazers_count: number
    updated_at: string
}

export async function fetchUserRepos(token: string): Promise<GitHubRepo[]> {
    try {
        console.log('🔍 Fetching GitHub repos with token:', token.substring(0, 10) + '...')
        
        const response = await axios.get('https://api.github.com/user/repos', {
            params: {
                per_page: 100,
                sort: 'updated'
            },
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'Commeta-Bot'
            },
            timeout: 10000
        })
        
        console.log(`✅ Successfully fetched ${response.data.length} repositories`)
        return response.data
    } catch (error) {
        console.error('❌ GitHub API Error:', error)
        
        if (axios.isAxiosError(error)) {
            if (error.response) {
                const status = error.response.status
                const message = error.response.data?.message || 'Unknown error'
                
                if (status === 401) {
                    throw new Error('Invalid GitHub token. Please check your token permissions.')
                } else if (status === 403) {
                    throw new Error('GitHub API rate limit exceeded or insufficient permissions.')
                } else if (status === 404) {
                    throw new Error('GitHub API endpoint not found.')
                } else {
                    throw new Error(`GitHub API error (${status}): ${message}`)
                }
            } else if (error.request) {
                throw new Error('Network error: Could not reach GitHub API')
            }
        }
        
        throw new Error(`Failed to fetch repositories: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
}

export function formatRepoList(repos: GitHubRepo[], localRepos: any[] = []): string {
    if (repos.length === 0) {
        return 'No repositories found in your GitHub account.'
    }

    const formatted = repos.slice(0, 20).map((repo, idx) => {
        const isLocal = localRepos.some(local => local.repoUrl === repo.clone_url)
        const localIcon = isLocal ? '📁' : ''
        const privateIcon = repo.private ? '🔒' : '🌐'
        const lang = repo.language ? `[${repo.language}]` : ''
        
        return `${idx + 1}. ${privateIcon} ${repo.name} ${lang} ${localIcon}
   ${repo.description || 'No description'}
   ⭐ ${repo.stargazers_count} • Updated: ${new Date(repo.updated_at).toLocaleDateString()}`
    }).join('\n\n')

    return `📚 *Your GitHub Repositories:*\n\n${formatted}\n\n💡 Say "clone [repo name]" to clone any repository!`
}

export function findRepoByName(repos: GitHubRepo[], searchName: string): GitHubRepo | null {
    const normalizedSearch = searchName.toLowerCase().trim()
    
    // First try exact match
    let found = repos.find(repo => repo.name.toLowerCase() === normalizedSearch)
    if (found) return found
    
    // Then try partial match
    found = repos.find(repo => repo.name.toLowerCase().includes(normalizedSearch))
    if (found) return found
    
    // Finally try description match
    found = repos.find(repo => 
        repo.description && repo.description.toLowerCase().includes(normalizedSearch)
    )
    
    return found || null
} 
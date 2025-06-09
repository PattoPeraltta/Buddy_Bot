# 🚀 Vercel Deployment via WhatsApp

Commeta now supports seamless Vercel deployment directly from WhatsApp! Deploy your projects with a single command and manage deployments on the go.

## ✨ Features

- **One-command deployment** - Deploy to production with `/deploy`
- **Preview deployments** - Test changes with `/deploy-preview`
- **Token-based authentication** - Secure token storage with `/vercel-token`
- **Deployment status** - Check live URLs with `/vercel-status`
- **Real-time logs** - Get deployment logs with `/vercel-logs`
- **Auto-detection** - Automatically detects project type and generates `vercel.json`
- **Smart workflow** - Optional auto-deploy prompt after git commits
- **Framework support** - Works with Next.js, React, Vue, Angular, Express, and more

## 🛠️ Setup

### 1. Install Vercel CLI

```bash
npm install -g vercel
```

### 2. Get Your Vercel Token

1. Visit [https://vercel.com/account/tokens](https://vercel.com/account/tokens)
2. Click "Create Token"
3. Give it a name (e.g., "WhatsApp Bot")
4. Copy the generated token

### 3. Save Token in Commeta

Send to your WhatsApp bot:
```
/vercel-token <your_token_here>
```

✅ **That's it!** You're ready to deploy!

## 📱 Commands

### Core Deployment
- **`/deploy`** - Deploy current repository to Vercel (production)
- **`/deploy-preview`** - Deploy as preview/staging environment
- **`/vercel-status`** - Check deployment status and get live URLs
- **`/vercel-logs`** - Get recent deployment logs

### Authentication & Setup
- **`/vercel-token <token>`** - Save your Vercel authentication token
- **`/vercel-auth`** - Get help with Vercel authentication

## 🎯 Quick Start

1. **Clone a repository** (if you haven't already):
   ```
   /clone https://github.com/your/repo
   ```

2. **Save your Vercel token**:
   ```
   /vercel-token vrc_1234567890abcdef...
   ```

3. **Deploy to production**:
   ```
   /deploy
   ```

4. **Or deploy as preview**:
   ```
   /deploy-preview
   ```

5. **Check status anytime**:
   ```
   /vercel-status
   ```

## 🔄 Automated Workflow

After making code changes with `/vibe`, Commeta will:

1. ✅ Apply AI-generated code changes
2. ✅ Commit changes to git
3. ✅ Push to GitHub
4. 🤖 **Ask if you want to deploy to Vercel!**

Just reply with "deploy" or "yes" to instantly deploy your changes!

## 🎨 Supported Project Types

Commeta automatically detects and configures:

- **Next.js** - Full-stack React applications
- **React** - Static React apps
- **Vue.js** - Vue applications  
- **Angular** - Angular applications
- **Express** - Node.js APIs
- **Static HTML** - Plain HTML/CSS/JS sites
- **And more!**

## 🔐 Security

- ✅ Tokens are **encrypted** and stored locally
- ✅ Only you can access your deployments
- ✅ Tokens never appear in chat logs
- ✅ Secure environment variable injection

## 📋 Examples

### Deploy a Next.js App
```
User: /clone https://github.com/vercel/next.js/tree/canary/examples/hello-world
Bot: ✅ Repository cloned successfully!

User: /vercel-token vrc_abc123...
Bot: ✅ Vercel token saved!

User: /deploy
Bot: 🚀 Starting Vercel deployment...
Bot: ✅ Deployment successful! 🎉
     🌐 Live URL: https://hello-world-abc123.vercel.app
```

### Check Deployment Status
```
User: /vercel-status
Bot: ✅ Deployment Status
     🌐 Latest URL: https://my-app-xyz789.vercel.app
     ⏰ Last updated: 2 minutes ago
     📊 Total deployments: 5
```

### Get Deployment Logs
```
User: /vercel-logs
Bot: 📜 Recent Deployment Logs:
     
     2023-12-07 15:30:21 - Build started
     2023-12-07 15:30:45 - Installing dependencies
     2023-12-07 15:31:20 - Build completed successfully
     2023-12-07 15:31:25 - Deployment ready
```

## 🚨 Troubleshooting

### "Not authenticated" error
- Use `/vercel-token <your_token>` to save your token
- Get a new token from https://vercel.com/account/tokens

### "Vercel CLI not found"
- Install globally: `npm install -g vercel`

### Deployment failed
- Check `/vercel-logs` for detailed error information
- Ensure your project has the right build settings
- Verify your token has the necessary permissions

## 🌟 Pro Tips

1. **Use preview deployments** first to test changes safely
2. **Check logs** if deployments fail for debugging info
3. **Combine with `/vibe`** for the ultimate AI-powered development workflow
4. **Set up multiple projects** - each repo can be deployed independently

---

*Built with ❤️ for the ultimate developer experience via WhatsApp!*

For more help, use `/help` in WhatsApp or visit [Vercel Documentation](https://vercel.com/docs). 
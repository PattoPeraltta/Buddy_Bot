# Buddy - Your AI Coding Assistant on WhatsApp

Buddy is a powerful, AI-driven WhatsApp bot that acts as your personal coding assistant. It allows you to manage your GitHub repositories, edit code using natural language, and deploy your projects to Vercel, all from the comfort of your WhatsApp chat.

![image](https://github.com/user-attachments/assets/e8a8a47e-a4af-4e1b-b72e-0a568b753a3b)


## ✨ Features

- **GitHub Integration**: Securely connect your GitHub account to list, clone, and switch between your repositories.
- **AI-Powered Code Editing**: Use the `/vibe` command with a natural language prompt (e.g., `/vibe add a login form`) to let the AI edit your code.
- **Vercel Deployments**: Easily deploy your projects to Vercel for production or preview with a single command.
- **Intelligent Commits**: The bot analyzes your changes to generate semantic commit messages automatically.
- **Visual Diff Previews**: Before you commit, the bot sends an image of the code differences for your review.
- **Natural Language Understanding**: The bot can understand commands in a conversational way (e.g., "clone my-project").
- **Audio Message Support**: Send voice notes with your instructions, and the bot will transcribe them and act accordingly.
- **Secure & Private**: Your credentials (like GitHub and Vercel tokens) are stored securely, and the bot only responds to whitelisted phone numbers.
- **Status Tracking**: Get a quick overview of the current repository status, including pending changes.

## ⚙️ How It Works

The bot is built on a modern stack, orchestrating several services to provide a seamless experience:

1.  **WhatsApp Interface**: Uses [Baileys](https://github.com/WhiskeySockets/Baileys) to connect to the WhatsApp Web API, allowing it to send and receive messages.
2.  **Node.js Backend**: The core application is a TypeScript/Node.js server that handles incoming messages, manages user state, and processes commands.
3.  **AI Code Generation**: For code editing tasks (`/vibe`), the bot uses [**Janito**](https://github.com/joaompinto/janito), a powerful command-line AI agent that can understand prompts and apply changes to the codebase.
4.  **Version Control**: Interacts with local repositories using `simple-git`.
5.  **Deployments**: Manages Vercel deployments through the official Vercel CLI.

## 🚀 Getting Started

### Prerequisites

Make sure you have the following installed on your system:

- **Node.js**: v18.x or higher.
- **Python**: v3.10 or higher.
- **Janito CLI**: The AI agent that powers code editing.
  ```bash
  pip install janito
  ```
- **Vercel CLI** (optional, for deployments):
  ```bash
  npm install -g vercel
  ```

### Installation & Setup

1.  **Clone the Repository**
    ```bash
    git clone <repository-url>
    cd <repository-name>
    ```

2.  **Install Node.js Dependencies**
    ```bash
    npm install
    ```

3.  **Configure Janito**
    Janito needs an AI provider API key to function. You can get one from [OpenAI](https://platform.openai.com) or any other supported provider.
    ```bash
    janito --set-api-key YOUR_OPENAI_API_KEY
    ```

4.  **Create a `.env` File**
    Create a `.env` file in the root of the project by copying the example file:
    ```bash
    cp .env.example .env
    ```
    Now, open the `.env` file and fill in the required values:

    ```env
    # The phone numbers allowed to interact with the bot (comma-separated)
    # Example: ALLOWED_PHONES=11234567890,19876543210
    ALLOWED_PHONES=

    # Bot configuration
    BOT_NAME="Buddy"
    AI_ENABLED=true

    # OpenAI API Key (for the bot's internal AI features like summarizing)
    OPENAI_API_KEY="sk-..."

    # Replicate API Key (for audio message transcription)
    # See https://replicate.com/
    REPLICATE_API_KEY="r8_..."

    # Secret for encrypting database values
    ENCRYPTION_SECRET="a_very_strong_and_long_secret_phrase"
    ```

### Running the Bot

1.  **Start the Bot**
    For development, use the `dev` script which enables hot-reloading:
    ```bash
    npm run dev
    ```
    For production, use:
    ```bash
    npm start
    ```

2.  **Connect to WhatsApp**
    On the first run, a QR code will be displayed in your terminal. Scan it with your phone using the WhatsApp "Linked Devices" feature. Once scanned, the bot is ready to go!

## 📖 Usage Guide

Interact with the bot by sending messages on WhatsApp.

### Basic Workflow

1.  **Say Hello**: Send `hello` or `hi` to get a welcome message with the main commands.
2.  **Authenticate GitHub**: Send your GitHub Personal Access Token to the bot. It will automatically detect and save it. You can also use the command:
    `/auth <your_github_token>`
3.  **List Repositories**: See all your GitHub repos.
    `/repos`
4.  **Clone a Repository**: Clone a repository by name or URL. The bot will find it in your cached repo list.
    `clone my-awesome-project`
    or
    `/clone https://github.com/user/my-awesome-project.git`
5.  **Set Active Repo**: Switch between your cloned projects.
    `/use my-awesome-project`
6.  **Edit Code with AI**: Tell the AI what you want to change.
    `/vibe create a new Express route for /users`
7.  **Review and Commit**: The bot will show you a preview of the changes and ask for confirmation. Reply with `yes` to commit and push to GitHub.
8.  **Deploy to Vercel**:
    - First, save your Vercel token: `/vercel-token <your_token>`
    - Then, deploy: `/deploy`

### Command Reference

| Command             | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `hello` / `hi`      | Displays a greeting and quick start guide.                                   |
| `/help`             | Shows the full list of available commands and features.                      |
| `/auth <token>`     | Saves your GitHub Personal Access Token.                                     |
| `/repos`            | Lists all your public and private GitHub repositories.                       |
| `/clone <url/name>` | Clones a repository.                                                         |
| `/use <repo-name>`  | Switches the active repository.                                              |
| `/status`           | Shows the current active repo and its Git status (uncommitted changes).      |
| `/vibe <prompt>`    | Starts an AI code editing session with your instructions.                    |
| `/deploy`           | Deploys the current project to Vercel (production).                          |
| `/deploy-preview`   | Deploys the current project as a preview/staging build on Vercel.            |
| `/vercel-token <t>` | Saves your Vercel authentication token.                                      |
| `/vercel-status`    | Checks the status of the latest Vercel deployment.                           |
| `/vercel-logs`      | Fetches the latest logs from your Vercel deployment.                         |

## 🏗️ Project Structure

```
src/
├── ai/         # AI-related functions (OpenAI, Janito integration)
├── config/     # Application configuration, environment variables
├── db/         # Simple JSON database (LowDB) for storing user data
├── handlers/   # Core logic for handling WhatsApp messages and audio
├── logger/     # Pino logger configuration
├── routes/     # Express routes (if any web interface is used)
├── server/     # Express server setup
├── types/      # TypeScript type definitions
├── utils/      # Utility functions (GitHub API, Vercel CLI wrappers)
└── index.ts    # Main application entry point
```

## 🤝 Contributing

Contributions are welcome! If you have ideas for new features or improvements, feel free to open an issue or submit a pull request.

1.  Fork the repository.
2.  Create your feature branch (`git checkout -b feature/my-new-feature`).
3.  Commit your changes (`git commit -am 'Add some feature'`).
4.  Push to the branch (`git push origin feature/my-new-feature`).
5.  Create a new Pull Request.

## 🗺️ Roadmap & Future Improvements

Here are some ideas for future improvements. Contributions are welcome!

-   [ ] **GitHub Actions Integration**: Trigger CI/CD pipelines or other workflows directly from WhatsApp.
-   [ ] **Enhanced User Experience**:
    -   [ ] Implement interactive messages (buttons, lists) for easier navigation.
    -   [ ] Provide more detailed feedback during long-running tasks.
    -   [ ] Personalized user settings and preferences.
-   [ ] **Improved Janito Capabilities**:
    -   [ ] Fine-tune the AI for more complex coding tasks.
    -   [ ] Allow users to select different AI models or profiles.
    -   [ ] Better context awareness within the entire repository.
-   [ ] **Support for More Platforms**:
    -   [ ] Integrate with other Git providers like GitLab or Bitbucket.
    -   [ ] Add support for other deployment platforms like Netlify or AWS.
-   [ ] **Advanced Project Management**:
    -   [ ] Create and manage GitHub Issues from WhatsApp.
    -   [ ] View project boards or to-do lists.
-   [ ] **More Robust Testing**: Expand unit and integration test coverage to ensure stability.



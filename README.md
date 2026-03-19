# MinaClaw: 24/7 Personal AI Agent

A redesign of the popular OpenClaw concept with security as prio1!

MinaClaw is a reliable, always-on AI daemon designed to assist with scheduling, browser automation, and local system management. It operates as a secure containerized service with a companion CLI tool for easy configuration and host-side interaction.

## Features

- **24/7 Availability**: Runs as a Docker daemon with internal task scheduling.
- **Multi-LLM Support**: Plug-and-play integration for OpenAI, Anthropic, Gemini, Mistral, xAI Grok, Kimi (Moonshot), and local Ollama instances — switch providers and submodels without touching any files.
- **Telegram Interface**: Chat with your agent, switch providers via `/model`, and schedule reminders via natural language.
- **Remote Browser Learning**: Connects to a Chrome instance on your LAN to "learn" new websites and generate markdown skills.
- **Secure Sandbox**: File operations are restricted to user-defined "safe" host directories mounted into the container.
- **Interactive CLI**: A polished terminal UI — configure providers individually, pick exact submodels, and see live configuration status without ever manually editing a file.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/install/)
- [Node.js](https://nodejs.org/) (for the host-side CLI tool)
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather))

## Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/minamfm/MinaClaw.git
   cd MinaClaw
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Link the CLI as a global command** (optional, run once):
   ```bash
   npm link
   ```

4. **Launch the CLI**:
   ```bash
   minaclaw
   # or without linking:
   node cli/minaclaw.js
   ```

5. **Follow the prompts**:
   - **Configure Providers & Model**: Set up whichever LLM providers you want — each has its own screen, you're never forced to enter all keys at once.
   - **Manage Safe Folders**: Add host directories you want the agent to access.
   - **Restart Daemon**: Builds the Docker image and starts the MinaClaw service.

## Supported LLM Providers

Each provider is configured independently via the CLI. The active provider and per-provider model are saved to `config/config.json` and take effect immediately.

| Provider | Models available |
|---|---|
| **OpenAI** | gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-4o, gpt-4o-mini, o3, o4-mini, o3-mini, o3-pro, o1 |
| **Anthropic** | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 |
| **Gemini** | gemini-2.5-flash, gemini-2.5-pro, gemini-1.5-flash, gemini-1.5-pro |
| **Mistral** | mistral-large-2411, mistral-medium, mistral-small, magistral-medium, magistral-small, codestral |
| **xAI Grok** | grok-4.1, grok-4.1-mini, grok-4.1-fast-reasoning, grok-4.1-fast-non-reasoning, grok-3-beta |
| **Kimi (Moonshot)** | moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k |
| **Ollama (Local)** | any model you have pulled (e.g. llama3, mistral, codellama) |

## Usage

### Telegram Bot
Once the daemon is running, message your bot on Telegram:
- **General Help**: Just chat in natural language.
- **Reminders**: "Remind me in 15 minutes to feed the cat."
- **Model Swap**: `/model gemini` or `/model anthropic`.
- **Shell Commands**: `/sh ls -la` (runs inside the container, rooted at `/mnt/safe`).
- **Learn Website**: `/learn https://example.com` (requires Chrome running with remote debugging).

### Host-side CLI
Run `minaclaw` (or `node cli/minaclaw.js`) anytime to:
- Chat with the agent directly from your terminal.
- Configure providers — each provider has its own screen showing whether it's configured and which model is selected.
- Pick a specific submodel per provider (e.g. `o3-pro` for hard reasoning tasks, `gpt-4.1-nano` for fast/cheap operations).
- Edit the system prompt in your `$EDITOR`.
- Add or remove safe folder mounts.

### Browser Learning (CDP)
To use the `/learn` feature, start Chrome on your LAN with remote debugging enabled:
```bash
google-chrome --remote-debugging-port=9222
```
Set `CHROME_CDP_URL` via the Ollama config screen or directly in `config/.env` if your Chrome is on a different machine.

## Security
MinaClaw is designed with isolation in mind.
- **Filesystem**: The agent only has read/write access to directories explicitly added via the CLI's "Safe Folders" manager. These are mounted under `/mnt/safe` inside the container.
- **Networking**: The internal API (port 3000) is bound to `127.0.0.1` on the host, preventing external access to your daemon's control layer.

## License
ISC

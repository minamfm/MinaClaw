# MinaClaw: 24/7 Personal AI Agent

A redesign of the popular OpenClaw concept with security as prio1!

MinaClaw is a reliable, always-on AI daemon designed to assist with scheduling, browser automation, and local system management. It operates as a secure containerized service with a companion CLI tool for easy configuration and host-side interaction.

## Features

- **24/7 Availability**: Runs as a Docker daemon with internal task scheduling.
- **Multi-LLM Support**: Plug-and-play integration for OpenAI, Gemini, Kimi (Moonshot), and local Ollama instances.
- **Telegram Interface**: Chat with your agent, switch models via `/model`, and schedule reminders via natural language.
- **Remote Browser Learning**: Connects to a Chrome instance on your LAN to "learn" new websites and generate markdown skills.
- **Secure Sandbox**: File operations are restricted to user-defined "safe" host directories mounted into the container.
- **Interactive CLI**: Manage API keys, mount safe folders, and chat with the agent directly from your terminal.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/install/)
- [Node.js](https://nodejs.org/) (for the host-side CLI tool)
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather))

## Installation

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/minamfm/MinaClaw.git
    cd MinaClaw
    ```

2.  **Install dependencies** for the host-side CLI:
    ```bash
    npm install
    ```

3.  **Launch the Interactive CLI**:
    ```bash
    node cli/minaclaw.js
    ```

4.  **Follow the CLI prompts**:
    - **Configure API Keys & Model**: Enter your Telegram token and LLM API keys.
    - **Manage Safe Folders**: Add host directories (e.g., `~/Documents/mina-safe`) that you want the agent to access.
    - **Restart Daemon**: This will build the Docker image and start the MinaClaw service.

## Usage

### Telegram Bot
Once the daemon is running, message your bot on Telegram:
- **General Help**: Just chat in natural language.
- **Reminders**: "Remind me in 15 minutes to feed the cat."
- **Model Swap**: `/model gemini` or `/model openai`.
- **Shell Commands**: `/sh ls -la` (outputs from within the container's `/mnt/safe` root).
- **Learn Website**: `/learn https://example.com` (requires Chrome running with remote debugging).

### Host-side CLI
Run `node cli/minaclaw.js` anytime to:
- Directly chat with the agent from your terminal.
- Update configuration without manually editing files.
- Monitor logs or update safe mount points.

### Browser Learning (CDP)
To use the `/learn` feature, start Chrome on your LAN with remote debugging enabled:
```bash
google-chrome --remote-debugging-port=9222
```
Ensure `CHROME_CDP_URL` in your `.env` (managed via the CLI) points to the correct IP/port.

## Security
MinaClaw is designed with isolation in mind.
- **Filesystem**: The agent only has read/write access to directories explicitly added via the CLI's "Safe Folders" manager. These are mounted under `/mnt/safe` inside the container.
- **Networking**: The internal API (port 3000) is bound to `127.0.0.1` on the host, preventing external access to your daemon's control layer.

## License
ISC

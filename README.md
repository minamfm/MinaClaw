# MinaClaw: 24/7 Personal AI Agent

A redesign of the popular OpenClaw concept with security as prio1!

MinaClaw is a reliable, always-on AI daemon designed to assist with scheduling, browser automation, and local system management. It runs as a secure containerized service with a companion CLI tool for configuration and host-side interaction.

## Features

- **24/7 Availability**: Runs as a Docker daemon with internal task scheduling.
- **Multi-LLM Support**: Plug-and-play integration for OpenAI, Anthropic, Gemini, Mistral, xAI Grok, Kimi (Moonshot), and local Ollama — switch providers and submodels without touching any files.
- **Telegram Interface**: Chat with your agent, switch providers via `/model`, schedule natural-language reminders, approve shell commands, and receive proactive messages from the agent.
- **Long-Term Memory**: The agent maintains two persistent files — `identity.md` (who you are, your preferences) and `memory.md` (running notes, projects, deadlines) — injected into every conversation automatically.
- **Container-Native Tool Execution**: The agent runs shell commands inside its own container transparently (listing files, reading content, exploring `/mnt/safe`) without prompting you. Only commands that need to run on your host machine require approval.
- **Secure Sandbox**: File operations are restricted to user-defined "safe" host directories mounted into the container under `/mnt/safe`.
- **Remote Browser Learning**: Connects to a Chrome instance via Playwright CDP to study websites and generate reusable skill files.
- **Interactive CLI**: A polished terminal UI — configure providers, pick exact submodels, browse the filesystem to add safe folders, manage the daemon, and inspect memory files without editing anything manually.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/install/)
- [Node.js](https://nodejs.org/) (for the host-side CLI)
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
   - **Configure Providers & Model** — Set up whichever LLM providers you want.
   - **Manage Safe Folders** — Browse your filesystem interactively and select directories to grant access.
   - **Daemon Management → Start** — Builds the Docker image and starts the MinaClaw service.

## Supported LLM Providers

Each provider is configured independently via the CLI. The active provider and per-provider model are saved to `config/config.json` and take effect immediately on the running daemon.

| Provider | Models available |
|---|---|
| **OpenAI** | gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-4o, gpt-4o-mini, o3, o4-mini, o3-mini, o3-pro, o1 |
| **Anthropic** | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 |
| **Gemini** | gemini-2.5-flash, gemini-2.5-pro, gemini-1.5-flash, gemini-1.5-pro |
| **Mistral** | mistral-large-2411, mistral-medium, mistral-small, magistral-medium, magistral-small, codestral |
| **xAI Grok** | grok-4.1, grok-4.1-mini, grok-4.1-fast-reasoning, grok-4.1-fast-non-reasoning, grok-3-beta |
| **Kimi (Moonshot)** | moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k |
| **Ollama (Local)** | auto-discovered from your local Ollama instance; falls back to manual entry |

## CLI Menu Structure

```
  Chat with Agent
  Watch (run Telegram commands)
  ───────────────
  Configure Providers & Model
  Daemon Management
  Manage Safe Folders
  ───────────────
  Session & Memory
  About MinaClaw
  ───────────────
  Exit
```

### Daemon Management
Start, stop, restart, and check status — all with clean output (no raw Docker build logs). A live status badge shows whether the container is running and for how long.

### Safe Folders
An interactive filesystem browser: navigate directories with arrow keys, descend into subdirectories, and press Enter on **✓ Select this directory** to add it. Existing folders are shown in a scrollable list where you can rename the mount alias or delete entries.

### Session & Memory
View or clear `identity.md` and `memory.md`, clear the active chat session, and check daemon reachability and prompt version.

## Usage

### Telegram Bot
Once the daemon is running, message your bot on Telegram:
- **General chat**: Talk in natural language — the agent uses its memory to give contextually aware replies.
- **Reminders**: "Remind me in 15 minutes to check the build."
- **Model swap**: `/model gemini` or `/model anthropic`.
- **Shell commands**: `/sh <command>` — proposes a host-side command for your approval.
- **Learn website**: `/learn https://example.com` — requires Chrome running with remote debugging.
- **Proactive messages**: Ask the agent to "send me a message on Telegram" and it will — even from CLI mode.

### Agent Command Types

The agent has two distinct ways to run commands, chosen automatically:

| Type | Where it runs | Requires approval |
|---|---|---|
| `internal_exec` | Inside the Docker container | No — runs instantly and silently |
| `command_proposal` | On your host machine | Yes — shown in Telegram / CLI for approval |

The agent uses `internal_exec` freely to explore `/mnt/safe`, read files, run scripts, and gather information. It only escalates to `command_proposal` when a task genuinely requires host-level access (e.g., `apt install`, `systemctl`, accessing paths outside the container).

### Long-Term Memory
The agent maintains two files in `skills/`:
- **`identity.md`** — your name, role, preferences, and how you want the agent to behave. Written eagerly on first contact and updated as it learns more about you.
- **`memory.md`** — running notes: ongoing projects, deadlines, facts worth remembering. Appended selectively, not spammed.

Both files are injected into every LLM call. Manage them via **Session & Memory** in the CLI.

### Browser Learning (CDP)
Start Chrome on your machine with remote debugging enabled:
```bash
google-chrome --remote-debugging-port=9222
```
Set `CHROME_CDP_URL` in `config/.env` if Chrome is on a different host. Then use `/learn <url>` in Telegram to generate a skill file.

## Security

- **Filesystem**: The agent only has access to directories explicitly added via **Manage Safe Folders**. These are mounted under `/mnt/safe` inside the container. The agent checks this mount point dynamically — no paths are hardcoded or guessed.
- **Host commands**: Any command that needs to run on your host machine is surfaced as a `command_proposal` with a one-sentence explanation. You approve or cancel — nothing runs on the host without your consent.
- **Networking**: The internal API (port 6192) is bound to `127.0.0.1` on the host, preventing external access to the daemon's control layer.
- **Container isolation**: The daemon runs inside Docker. `internal_exec` commands execute within the container only, with no access to host paths outside of configured safe folder mounts.

## License
ISC

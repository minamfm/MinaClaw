<div align="center">

# MinaClaw

**Your 24/7 personal AI agent. Runs anywhere. Remembers everything. Learns on demand.**

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green?logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker)](https://www.docker.com)
[![Telegram](https://img.shields.io/badge/Telegram-bot-26A5E4?logo=telegram)](https://telegram.org)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-bot-25D366?logo=whatsapp)](https://whatsapp.com)

</div>

---

MinaClaw is a self-hosted AI agent daemon that runs 24/7 in Docker. Talk to it over Telegram or WhatsApp, give it tasks, let it learn skills from websites and codebases, schedule reminders, execute shell commands on your machine — all with a persistent memory that carries across every conversation.

> **Not just a chatbot.** MinaClaw is a personal agent that knows who you are, remembers what you've discussed, and can act on your behalf — safely, on your own infrastructure.

---

## What makes it different

| Feature | MinaClaw |
|---|---|
| **Multi-LLM, runtime switching** | 8 providers — switch mid-conversation with `/model` |
| **Persistent memory** | `identity.md` + `memory.md` injected into every prompt automatically |
| **Learns new skills** | `/learn <url>` visits any website and writes a skill file; `/learn_dir` does the same from a codebase |
| **Two-tier execution** | Runs container commands freely; proposes host commands for your approval with inline buttons |
| **Dual bot interface** | Telegram + WhatsApp supported out of the box |
| **Web portal** | Built-in dashboard for chat, logs, config, and usage stats |
| **Self-hosted** | Your keys, your data, your machine |

---

## Quick start

```bash
# 1. Clone and install CLI dependencies
git clone https://github.com/your-username/minaclaw.git
cd minaclaw
npm install && npm link   # makes 'minaclaw' available globally

# 2. Launch the setup wizard
minaclaw

# 3. Configure your API keys and Telegram bot token in the wizard
# 4. Start daemon  →  Manage Daemon → Start
# 5. Open Telegram and talk to your bot
```

That's it. The daemon runs in Docker and restarts automatically on reboot.

---

## Requirements

- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/install/)
- [Node.js](https://nodejs.org) 20+ (for the CLI only — the daemon runs inside Docker)
- A [Telegram bot token](https://t.me/BotFather) (takes 30 seconds to create)
- At least one LLM API key — or a local [Ollama](https://ollama.ai) instance for fully offline use

---

## Installation

### 1. Clone

```bash
git clone https://github.com/your-username/minaclaw.git
cd minaclaw
```

### 2. Install CLI dependencies

```bash
npm install
npm link   # optional — makes 'minaclaw' a global command
```

### 3. Run the interactive setup wizard

```bash
minaclaw
# or without linking:
node cli/minaclaw.js
```

The wizard walks you through:
- Entering API keys (OpenAI, Anthropic, Gemini, Mistral, Grok, Kimi, DeepSeek, Ollama URL)
- Setting your Telegram bot token
- Choosing your default LLM provider and submodel
- Adding safe host directories the agent can access
- Starting the Docker daemon

> **Manual setup**: copy `.env.example` to `config/.env`, fill in your keys, then run `docker compose up -d`.

---

## LLM providers

Switch providers at any time with `/model <provider>` in Telegram — no restart needed.

| Provider | Models | Notes |
|---|---|---|
| **OpenAI** | gpt-4o, gpt-4o-mini, o3, o4-mini, gpt-4.1 series, gpt-5.4 series | Required for voice transcription (Whisper) |
| **Anthropic** | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 | |
| **Google Gemini** | gemini-2.5-pro, gemini-2.5-flash, gemini-1.5 series | Thinking-capable |
| **Mistral** | mistral-large, mistral-medium, codestral, magistral series | |
| **xAI Grok** | grok-4.1, grok-4.1-mini, grok-3-beta | 256K context |
| **Kimi (Moonshot)** | kimi-k2.5, kimi-k2-thinking, moonshot-v1-128k | 262K context, reasoning |
| **DeepSeek** | deepseek-chat (V3), deepseek-reasoner (R1) | Chain-of-thought reasoning |
| **Ollama** | Any locally installed model | Fully offline, no API key needed |

---

## Telegram commands

| Command | What it does |
|---|---|
| `<message>` | Chat with your agent |
| 🎤 Voice message | Transcribed via Whisper, treated as text |
| `/model <provider>` | Switch LLM provider |
| `/models` | List all providers and active model |
| `/learn <url>` | Visit a website and generate a skill file |
| `/learn_dir <path>` | Read a codebase under `/mnt/safe` and synthesize a skill |
| `/sh <command>` | Propose a shell command to run on your host |
| `/kill` | Stop the current task |

### Command approval flow

When the agent wants to run something on your host machine, it sends you an inline Telegram message:

```
Run on host: docker ps -a
[✅ Run it]  [🔁 Always this session]  [❌ Cancel]
```

Container-internal operations (reading files, listing directories, running scripts within `/mnt/safe`) happen silently without any prompt.

---

## Memory and skills

MinaClaw maintains two persistent memory files:

- **`skills/identity.md`** — who you are, your preferences, your setup. The agent updates this as it learns about you.
- **`skills/memory.md`** — running notes: projects, deadlines, things you've asked it to remember.

Both are injected into every conversation automatically.

### Teaching new skills

```
/learn https://docs.some-api.com
```

MinaClaw opens the page via a headless Chrome instance (Playwright CDP), reads the content, and writes a `<domain>_skill.md` file. Next time you ask about that API, it already knows how to use it.

```
/learn_dir my-project
```

Points the agent at a directory under your safe folder. It reads the source, understands the architecture, and writes a skill file — so it can help you work on the codebase without re-explaining it every session.

---

## Web portal

The daemon serves a built-in dashboard at `http://localhost:3004`:

- **Chat** — talk to your agent from the browser
- **Models** — switch provider and submodel
- **Config** — manage API keys and settings
- **Logs** — live daemon log tail
- **Usage** — token counts and estimated cost per provider over 24h
- **WhatsApp** — QR code pairing and number management

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Docker container                    │
│                                                       │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────┐  │
│  │ Telegram │   │ WhatsApp │   │   Web portal     │  │
│  │   bot    │   │   bot    │   │   :3004          │  │
│  └────┬─────┘   └────┬─────┘   └────────┬─────────┘  │
│       └──────────────┴──────────────────┘             │
│                       │                               │
│             ┌─────────▼─────────┐                    │
│             │    Agent loop     │                    │
│             │  queryLLMLoop()   │                    │
│             └─────────┬─────────┘                    │
│                       │                               │
│         ┌─────────────┼─────────────┐                │
│         ▼             ▼             ▼                │
│   internal_exec   fetch_url   command_proposal       │
│   (no approval)  search_web   (you approve)          │
│                                     │                │
│   /mnt/safe ◄── file ops ───────────┘                │
│   (your dirs)                                        │
│                                                      │
│   skills/  ←→  memory  ←→  sessions/                │
└──────────────────────────────────────────────────────┘
             │ CLI API :6192 (127.0.0.1 only)
             ▼
       minaclaw CLI
       (host-side)
```

---

## Security model

| Boundary | How it's enforced |
|---|---|
| **File system** | Agent can only read/write within `/mnt/safe` — your chosen directories, nothing else |
| **Host commands** | Require your approval via Telegram inline buttons every time (or "always this session") |
| **Internal API** | Port 6192 bound to `127.0.0.1` only — never reachable externally |
| **Secrets** | API keys live in `config/.env` (gitignored), passed as env vars — never in code |
| **Destructive commands** | `rm -rf /`, `mkfs`, and similar are blocklisted |

---

## Safe folders

Safe folders are host directories you explicitly mount into the container. The agent can freely read and write inside them. Add them through the CLI:

```
minaclaw → Manage Safe Folders → Add folder
```

They appear as `/mnt/safe/<name>` inside the container. Nothing outside them is accessible.

---

## Scheduling

MinaClaw understands natural language. Just tell it:

> "Remind me in 2 hours to push the release"
> "Every weekday at 9am, send me a summary of my tasks"

It extracts the intent, creates the job, and messages you when it fires. Jobs persist in `config/scheduled-jobs.json` and survive daemon restarts.

---

## Offline use with Ollama

Run MinaClaw with no external API keys:

```bash
# Install and start Ollama
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull llama3

# In MinaClaw: Select LLM Provider → ollama
# OLLAMA_URL defaults to http://localhost:11434
```

---

## Configuration reference

| File | Purpose |
|---|---|
| `config/.env` | API keys and bot tokens (gitignored) |
| `config/config.json` | Active model, per-provider model selection, system prompt |
| `config/scheduled-jobs.json` | Persistent scheduled jobs |
| `config/daemon.log` | Daemon logs |
| `config/sessions/` | Per-session conversation history |
| `skills/identity.md` | Your persistent identity context |
| `skills/memory.md` | Agent's running memory |
| `skills/*_skill.md` | Learned skills (auto-generated) |

### Environment variables

```env
# Required
TELEGRAM_BOT_TOKEN=

# LLM providers — add the ones you use
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
MISTRAL_API_KEY=
XAI_API_KEY=
KIMI_API_KEY=
DEEPSEEK_API_KEY=

# Local / optional
OLLAMA_URL=http://localhost:11434
CHROME_CDP_URL=ws://localhost:9222

# Web search (optional)
BRAVE_API_KEY=
GOOGLE_SEARCH_API_KEY=
GOOGLE_SEARCH_CX=
```

---

## CLI menu

```
minaclaw
 ├── Configure Settings         → API keys, bot tokens
 ├── Select LLM Provider        → Switch active provider + submodel
 ├── Manage Safe Folders        → Add/remove host directories
 ├── Manage Daemon              → Start / Stop / Restart / View logs
 ├── View Memory Files          → Read identity.md and memory.md
 ├── Manage Sessions            → List and clear conversation history
 ├── Manage Scheduled Jobs      → View, add, delete cron/one-time jobs
 └── Exit
```

---

## Contributing

Contributions are welcome. Please [open an issue](../../issues) before starting significant work so we can align on the approach.

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for full details.

---

## License

[ISC](LICENSE)

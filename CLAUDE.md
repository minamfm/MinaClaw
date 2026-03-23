# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install host-side CLI dependencies
npm install

# Link the CLI as a global executable (run once after install)
npm link

# Launch the interactive management CLI
minaclaw
# or without linking:
node cli/minaclaw.js

# Build and start the daemon in Docker
docker compose up -d --build

# View daemon logs
docker compose logs -f
```

There is no test suite configured — `npm test` exits with an error.

## Architecture

MinaClaw is a **two-tier system**:

1. **Docker Daemon** (`index.js` → runs inside container) — the always-on AI agent. Exposes an HTTP API on port 3000 (bound to `127.0.0.1` on the host) and runs the Telegram bot.
2. **Host-side CLI** (`cli/minaclaw.js`) — an interactive terminal tool (using `inquirer`) that connects to the daemon's HTTP API, manages configuration files, and controls Docker via `docker compose` shell calls.

### Source modules (`src/`)

| File | Role |
|---|---|
| `config.js` | Reads/writes `config/config.json` (active model, system prompt). Path is `/app/config/config.json` in production, local `config.json` in dev. |
| `llm.js` | Unified `queryLLM(messages)` that dispatches to OpenAI, Gemini, Kimi/Moonshot, Ollama, Mistral, Grok based on `activeModel` in config. |
| `telegram.js` | Telegraf bot. Commands: `/model <name>`, `/learn <url>`, `/sh <cmd>`. Free-text and voice messages both route through the shared `processMessage(ctx, text, sessionId)` function. Voice messages are transcribed via OpenAI Whisper before being passed to the LLM. Supports streaming (`onChunk`), thinking display (`onThinking`), and tool-call progress messages (`onProgress`) — progress messages are currently **disabled** (pass `null` to `queryLLMLoop`; swap back to `onProgress` to re-enable). |
| `scheduler.js` | Sends the user's reminder text to the LLM to extract a cron expression + message, then schedules it with `node-cron`. Jobs are **in-memory only** — lost on daemon restart. |
| `browser.js` | Connects to a remote Chrome instance via Playwright CDP (`CHROME_CDP_URL`), visits a URL, extracts page text, asks the LLM to generate a skill markdown file, and saves it to `skills/<domain>_skill.md`. |
| `tools.js` | `executeShellCommand` (10s timeout, minimal blocklist), `readFile`/`writeFile` confined to `/mnt/safe` in production via `resolvePath`. |

### Configuration & secrets

- **API keys** (`config/.env`): `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `KIMI_API_KEY`, `MISTRAL_API_KEY`, `GROK_API_KEY`
- **Runtime config** (`config/config.json`): `activeModel` (openai/gemini/kimi/ollama/anthropic/mistral/grok), `systemPrompt`
- **Kimi base URL**: `https://api.moonshot.ai/v1` (not `.cn`). Model: `kimi-k2.5`. Thinking disabled server-side via `extra_body: { thinking: { type: 'disabled' } }`.
- **Optional env vars**: `CHROME_CDP_URL` (default: `ws://localhost:9222`), `OLLAMA_URL` (default: `http://localhost:11434`)
- Both `config/` and `skills/` are mounted into the container as volumes so they persist across restarts.

### Safe folder sandboxing

Host directories added via the CLI are mounted under `/mnt/safe/<name>` inside the container. `tools.js` enforces that all file operations stay within `/mnt/safe` when `NODE_ENV=production`. The `/sh` Telegram command runs arbitrary shell commands — this is intentional but the sandbox relies entirely on Docker isolation and the `/mnt/safe` mount constraint.

### Adding a new LLM provider

Add a query function in `src/llm.js` and a new case in the `queryLLM` switch, then add the corresponding API key prompt to `cli/minaclaw.js`'s `configureSettings` and register the model name in the `/model` command validator in `src/telegram.js`.

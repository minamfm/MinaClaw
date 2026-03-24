# Contributing to MinaClaw

Thanks for your interest in contributing. Here's how to get started.

## Before you start

For anything beyond a small bug fix or typo, please [open an issue](../issues) first so we can discuss the approach. This saves everyone time.

## Setup

```bash
git clone https://github.com/your-username/minaclaw.git
cd minaclaw
npm install
```

The daemon runs in Docker. For development, you can run it directly:

```bash
node index.js
```

Set up `config/.env` with your API keys (copy from `.env.example`).

## Project structure

```
index.js          # Daemon entry point
cli/minaclaw.js   # Host-side CLI
src/
  llm.js          # LLM provider routing and tool calling
  telegram.js     # Telegram bot
  whatsapp.js     # WhatsApp bot
  scheduler.js    # Cron and one-time jobs
  browser.js      # Playwright skill learning
  tools.js        # Shell execution and file ops
  config.js       # Config load/save
  session.js      # Conversation history
  memory.js       # identity.md / memory.md management
public/
  index.html      # Web portal (single file)
```

## Adding a new LLM provider

1. Add a query function in `src/llm.js`
2. Add a new case in the `queryLLM` switch
3. Add the API key prompt in `cli/minaclaw.js` → `configureSettings`
4. Register the model name in the `/model` validator in `src/telegram.js`
5. Update the provider table in `README.md`

## Pull requests

- Keep PRs focused — one feature or fix per PR
- Match the existing code style (no linter is configured, just be consistent)
- Update `README.md` if your change affects user-facing behavior
- Add your provider/feature to the relevant section of the docs

## Commit style

```
type: short description

# Types: feat, fix, refactor, docs, chore
```

Examples:
```
feat: add DeepSeek provider
fix: handle Telegram API timeout on /learn
docs: add Ollama offline setup section
```

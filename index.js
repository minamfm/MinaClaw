require('dotenv').config({ path: './config/.env' });
const express    = require('express');
const bodyParser = require('body-parser');
const axios      = require('axios');
const fs         = require('fs');
const path       = require('path');
const { startTelegramBot }                     = require('./src/telegram');
const { startWhatsAppBot, getStatus: getWAStatus, getQR, sendToJid } = require('./src/whatsapp');
const { queryLLM, queryLLMLoop, parseResponse } = require('./src/llm');
const { loadConfig, updateConfig }             = require('./src/config');
const { updateAgentConfig }                    = require('./src/tools');
const queue     = require('./src/command-queue');
const session   = require('./src/session');
const usageLog  = require('./src/usage');
const scheduler = require('./src/scheduler');

console.log('Starting MinaClaw daemon…');

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Chat endpoint — maintains per-session conversation history.
// sessionId defaults to 'cli' for the host CLI; Telegram passes chatId.
app.post('/chat', async (req, res) => {
  const { message, sessionId = 'cli' } = req.body;
  if (!message) return res.status(400).send('Message is required.');

  try {
    session.append(sessionId, 'user', message);
    const { text, usage, model, parsed, newMessages } = await queryLLMLoop(session.get(sessionId), { sessionId });
    for (const msg of newMessages) session.append(sessionId, msg.role, msg.content);
    if (usage) {
      session.addUsage(sessionId, usage.input, usage.output);
      usageLog.record(loadConfig().activeModel, model, usage.input, usage.output);
    }

    if (parsed.type === 'send_telegram') {
      const cfg = loadConfig();
      if (bot && cfg.telegramChatId) {
        bot.telegram.sendMessage(cfg.telegramChatId, parsed.message)
          .catch(err => console.error('Telegram send failed:', err.message));
      }
    }

    res.json({ ...parsed, model, usage: session.getUsage(sessionId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Host CLI watcher polls this to pick up Telegram-approved commands.
app.get('/pending-commands', (req, res) => {
  res.json(queue.dequeueAll());
});

// Host CLI watcher posts execution results; agent summarises and Telegram bot replies.
app.post('/command-result', async (req, res) => {
  const { chatId, output, command } = req.body;
  if (!chatId || output === undefined)
    return res.status(400).send('chatId and output are required.');

  const sessionId = chatId.toString();
  // Inject the result into the session so the agent has full context
  session.append(sessionId, 'user',
    `Command \`${command}\` was executed on my machine. Output:\n\`\`\`\n${output}\n\`\`\``);

  try {
    const { text, usage, model: cmdModel, parsed, newMessages } = await queryLLMLoop(session.get(sessionId), { sessionId });
    for (const msg of newMessages) session.append(sessionId, msg.role, msg.content);
    if (usage) {
      session.addUsage(sessionId, usage.input, usage.output);
      usageLog.record(loadConfig().activeModel, cmdModel, usage.input, usage.output);
    }

    // Route result to WhatsApp if chatId is a JID, otherwise Telegram
    const isWhatsApp = typeof chatId === 'string' && chatId.includes('@');

    if (isWhatsApp) {
      if (parsed.type === 'command_proposal') {
        const { sendToJid: wa } = require('./src/whatsapp');
        const id = queue.enqueue(chatId, parsed.command, parsed.explanation);
        await wa(chatId,
          `📋 *Command Proposal*\n\nReason: ${parsed.explanation}\nCommand: ${parsed.command}\n\nReply *yes* to approve or *no* to cancel.`
        ).catch(() => {});
      } else {
        const { sendToJid: wa } = require('./src/whatsapp');
        const reply = (parsed.type === 'text' ? parsed.response : null) || text;
        if (reply) await wa(chatId, reply).catch(() => {});
      }
      return res.json({ ok: true });
    }

    if (!bot) return res.json({ ok: true });

    if (parsed.type === 'command_proposal') {
      // Agent needs to run another host command — show the approval buttons
      const id = queue.enqueue(chatId, parsed.command, parsed.explanation);
      await bot.telegram.sendMessage(chatId,
        `📋 *Command proposal*\n\n_Reason:_ ${parsed.explanation}\n\`\`\`\n${parsed.command}\n\`\`\`\n\nThis will run on your host machine via the MinaClaw watcher.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Run it',              callback_data: `approve:${id}`     },
              { text: '🔁 Always this session', callback_data: `approve_all:${id}` },
              { text: '❌ Cancel',              callback_data: `cancel:${id}`      },
            ]],
          },
        }
      ).catch(err => console.error('Failed to send command proposal:', err.message));
    } else {
      const reply = (parsed.type === 'text' ? parsed.response : null) || text;
      await bot.telegram.sendMessage(chatId, reply)
        .catch(err => console.error('Failed to send Telegram message:', err.message));
    }
  } catch (err) {
    console.error('command-result handler error:', err.message);
    if (bot) {
      await bot.telegram.sendMessage(chatId,
        `Command finished.\n\`\`\`\n${output}\n\`\`\``
      ).catch(() => {});
    }
  }

  res.json({ ok: true });
});

app.post('/session/clear', (req, res) => {
  const { sessionId = 'cli' } = req.body || {};
  session.clear(sessionId);
  res.json({ ok: true });
});

app.get('/sessions/list', (req, res) => {
  res.json(session.list());
});

app.get('/session/:id/history', (req, res) => {
  res.json(session.get(req.params.id));
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── WhatsApp API ─────────────────────────────────────────────────────────────

app.get('/whatsapp/status', (req, res) => res.json(getWAStatus()));

app.get('/whatsapp/qr', (req, res) => {
  const qr = getQR();
  if (!qr) return res.status(404).json({ error: 'No QR available' });
  res.json({ qr });
});

app.post('/whatsapp/bind', (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ error: 'number required' });
  const normalized = number.replace('+', '');
  const cfg  = loadConfig();
  const list = [...(cfg.whatsappAllowedNumbers || [])];
  if (!list.some(n => n.replace('+', '') === normalized)) {
    list.push(normalized);
    updateConfig({ whatsappAllowedNumbers: list });
  }
  res.json({ ok: true, numbers: list });
});

app.post('/whatsapp/unbind', (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ error: 'number required' });
  const normalized = number.replace('+', '');
  const cfg  = loadConfig();
  const list = (cfg.whatsappAllowedNumbers || []).filter(n => n.replace('+', '') !== normalized);
  updateConfig({ whatsappAllowedNumbers: list });
  res.json({ ok: true, numbers: list });
});

app.get('/whatsapp/numbers', (req, res) => {
  const cfg = loadConfig();
  res.json({ numbers: cfg.whatsappAllowedNumbers || [] });
});

// ─── Scheduler API ────────────────────────────────────────────────────────────

app.post('/schedule/add', (req, res) => {
  const { delaySeconds, cronExpr, command, label } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  if (cronExpr) {
    const id = scheduler.addCronJob({ cronExpr, command, label });
    return res.json({ id, type: 'recurring' });
  }
  if (delaySeconds == null) return res.status(400).json({ error: 'delaySeconds or cronExpr required' });
  const id = scheduler.addOneTimeJob({ delayMs: delaySeconds * 1000, command, label });
  res.json({ id, type: 'once' });
});

app.get('/schedule/list', (req, res) => {
  res.json(scheduler.listJobs());
});

app.delete('/schedule/:id', (req, res) => {
  const ok = scheduler.cancelJob(req.params.id);
  if (!ok) return res.status(404).json({ error: 'job not found' });
  res.json({ ok: true });
});

app.post('/whatsapp/send', async (req, res) => {
  const { jid, message } = req.body;
  if (!jid || !message) return res.status(400).json({ error: 'jid and message required' });
  await sendToJid(jid, message);
  res.json({ ok: true });
});

// ─── Env API (used by web portal) ────────────────────────────────────────────

const ENV_KEYS = ['TELEGRAM_BOT_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY',
                  'KIMI_API_KEY','MISTRAL_API_KEY','XAI_API_KEY','DEEPSEEK_API_KEY'];
const ENV_PATH = process.env.NODE_ENV === 'production'
  ? '/app/config/.env'
  : path.join(__dirname, 'config', '.env');

app.get('/env', (req, res) => {
  const result = {};
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    ENV_KEYS.forEach(k => {
      const m = content.match(new RegExp(`^${k}=(.+)$`, 'm'));
      result[k] = !!(m && m[1].trim());
    });
  } catch { ENV_KEYS.forEach(k => result[k] = false); }
  res.json(result);
});

app.post('/env', (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
  const msg = updateAgentConfig('env', key, value);
  res.json({ ok: true, message: msg });
});

// ─── Ollama models proxy ──────────────────────────────────────────────────────

app.get('/ollama/models', async (req, res) => {
  const url = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
  try {
    const r = await axios.get(`${url}/api/tags`, { timeout: 3000 });
    res.json((r.data.models || []).map(m => m.name));
  } catch { res.json([]); }
});

// ─── Config API (used by web portal) ─────────────────────────────────────────

app.get('/config', (req, res) => res.json(loadConfig()));

app.post('/config', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object')
    return res.status(400).json({ error: 'JSON body required' });
  const updated = updateConfig(updates);
  res.json(updated);
});

// ─── Logs API ─────────────────────────────────────────────────────────────────

app.get('/logs', (req, res) => {
  const logPath = process.env.NODE_ENV === 'production'
    ? '/app/config/daemon.log'
    : path.join(__dirname, 'config', 'daemon.log');
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    res.type('text/plain').send(lines.slice(-150).join('\n'));
  } catch {
    res.type('text/plain').send('Log file not found.');
  }
});

// ─── Usage API ────────────────────────────────────────────────────────────────

app.get('/usage', (req, res) => {
  res.json(usageLog.getLast24h());
});

// ─── Servers ──────────────────────────────────────────────────────────────────

const server = app.listen(6192, '0.0.0.0', () => {
  console.log('Internal CLI API listening on port 6192');
});

const PORTAL_PORT = parseInt(process.env.PORTAL_PORT || '3004');
app.listen(PORTAL_PORT, '0.0.0.0', () => {
  console.log(`Web portal listening on port ${PORTAL_PORT}`);
});

const bot = startTelegramBot();

// Start WhatsApp bot (non-fatal — logs error if it fails)
startWhatsAppBot().catch(err => console.error('[WhatsApp] Startup error:', err.message));

// Restore persistent scheduled jobs (runs any that fired while container was down)
scheduler.restoreJobs();

if (!bot) {
  console.log('Running in headless mode (no Telegram bot).');
} else {
  // Notify the user that the daemon is back online after a restart
  const cfg = loadConfig();
  if (cfg.telegramChatId) {
    setTimeout(() => {
      bot.telegram.sendMessage(cfg.telegramChatId, '🟢 Back online.')
        .catch(err => console.error('Startup notification failed:', err.message));
    }, 3000);
  }
}

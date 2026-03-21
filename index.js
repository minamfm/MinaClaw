require('dotenv').config({ path: './config/.env' });
const express    = require('express');
const bodyParser = require('body-parser');
const { startTelegramBot } = require('./src/telegram');
const { queryLLM, queryLLMLoop, parseResponse } = require('./src/llm');
const { loadConfig } = require('./src/config');
const queue   = require('./src/command-queue');
const session = require('./src/session');

console.log('Starting MinaClaw daemon…');

const app = express();
app.use(bodyParser.json());

// Chat endpoint — maintains per-session conversation history.
// sessionId defaults to 'cli' for the host CLI; Telegram passes chatId.
app.post('/chat', async (req, res) => {
  const { message, sessionId = 'cli' } = req.body;
  if (!message) return res.status(400).send('Message is required.');

  try {
    session.append(sessionId, 'user', message);
    const { text, usage, model, parsed, newMessages } = await queryLLMLoop(session.get(sessionId), { sessionId });
    for (const msg of newMessages) session.append(sessionId, msg.role, msg.content);
    if (usage) session.addUsage(sessionId, usage.input, usage.output);

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
    const { text, usage, parsed, newMessages } = await queryLLMLoop(session.get(sessionId), { sessionId });
    for (const msg of newMessages) session.append(sessionId, msg.role, msg.content);
    if (usage) session.addUsage(sessionId, usage.input, usage.output);

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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const server = app.listen(6192, '0.0.0.0', () => {
  console.log('Internal CLI API listening on port 6192');
});

const bot = startTelegramBot();

if (!bot) console.log('Running in headless mode (no Telegram bot).');

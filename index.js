require('dotenv').config({ path: './config/.env' });
const express    = require('express');
const bodyParser = require('body-parser');
const { startTelegramBot } = require('./src/telegram');
const { queryLLM, parseResponse } = require('./src/llm');
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
    const raw    = await queryLLM(session.get(sessionId));
    const parsed = parseResponse(raw);
    session.append(sessionId, 'assistant', raw);
    res.json(parsed);
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

  let reply;
  try {
    const raw    = await queryLLM(session.get(sessionId));
    const parsed = parseResponse(raw);
    session.append(sessionId, 'assistant', raw);
    reply = parsed.response || raw;
  } catch {
    reply = `Command finished.\n\`\`\`\n${output}\n\`\`\``;
  }

  if (bot) {
    try { await bot.telegram.sendMessage(chatId, reply); }
    catch (err) { console.error('Failed to send Telegram message:', err.message); }
  }

  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const server = app.listen(6192, '0.0.0.0', () => {
  console.log('Internal CLI API listening on port 6192');
});

const bot = startTelegramBot();

if (!bot) console.log('Running in headless mode (no Telegram bot).');

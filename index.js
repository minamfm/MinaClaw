require('dotenv').config({ path: './config/.env' });
const express = require('express');
const bodyParser = require('body-parser');
const { startTelegramBot } = require('./src/telegram');
const { queryLLM, parseResponse } = require('./src/llm');
const queue = require('./src/command-queue');

console.log('Starting MinaClaw Daemon in Docker...');

const app = express();
app.use(bodyParser.json());

// Chat endpoint — returns either a normal response or a command_proposal object.
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).send('Message is required.');

  try {
    const raw = await queryLLM([{ role: 'user', content: message }]);
    const parsed = parseResponse(raw);
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Host CLI watcher polls this to pick up Telegram-approved commands.
app.get('/pending-commands', (req, res) => {
  res.json(queue.dequeueAll());
});

// Host CLI watcher posts execution results here so the Telegram bot can reply.
app.post('/command-result', async (req, res) => {
  const { chatId, output, command } = req.body;
  if (!chatId || output === undefined) return res.status(400).send('chatId and output are required.');

  // Ask the LLM to summarise the result in a human-friendly way
  let reply;
  try {
    const raw = await queryLLM([{
      role: 'user',
      content: `The command \`${command}\` was executed on the user's host machine. Output:\n\`\`\`\n${output}\n\`\`\`\nSummarise the result helpfully and concisely.`,
    }]);
    const parsed = parseResponse(raw);
    reply = parsed.response || raw;
  } catch {
    reply = `Command finished.\n\`\`\`\n${output}\n\`\`\``;
  }

  if (bot) {
    try {
      await bot.telegram.sendMessage(chatId, reply);
    } catch (err) {
      console.error('Failed to send Telegram message:', err.message);
    }
  }

  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const server = app.listen(6192, '0.0.0.0', () => {
  console.log('Internal CLI API listening on port 6192');
});

const bot = startTelegramBot();

if (!bot) {
  console.log('MinaClaw is running in headless mode (No Telegram bot).');
}

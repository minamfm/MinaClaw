require('dotenv').config({ path: './config/.env' });
const express = require('express');
const bodyParser = require('body-parser');
const { startTelegramBot } = require('./src/telegram');
const { queryLLM } = require('./src/llm');

console.log('Starting MinaClaw Daemon in Docker...');

const app = express();
app.use(bodyParser.json());

// API for host CLI to chat with the daemon
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).send('Message is required.');
  
  try {
    const response = await queryLLM([{ role: 'user', content: message }]);
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(3000, '0.0.0.0', () => {
  console.log('Internal CLI API listening on port 3000');
});

const bot = startTelegramBot();

if (!bot) {
  console.log('MinaClaw is running in headless mode (No Telegram bot).');
}

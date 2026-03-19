const { Telegraf } = require('telegraf');
const { queryLLM } = require('./llm');
const { updateConfig } = require('./config');
const { handleScheduling } = require('./scheduler');
const { connectToChromeAndLearn } = require('./browser');
const { executeShellCommand } = require('./tools');

function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not found, skipping Telegram initialization.');
    return null;
  }

  const bot = new Telegraf(token);

  // Provide a command to easily switch models for testing
  bot.command('model', (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length > 1) {
      const newModel = args[1];
      if (['openai', 'gemini', 'kimi', 'ollama'].includes(newModel)) {
        updateConfig({ activeModel: newModel });
        return ctx.reply(`Switched active model to: ${newModel}`);
      }
      return ctx.reply('Invalid model. Choose from: openai, gemini, kimi, ollama');
    }
    return ctx.reply('Please specify a model. e.g., /model gemini');
  });

  bot.command('learn', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length > 1) {
      const url = args[1];
      ctx.reply(`Connecting to Chrome to learn from ${url}...`);
      const result = await connectToChromeAndLearn(url);
      return ctx.reply(result);
    }
    return ctx.reply('Please specify a URL. e.g., /learn https://example.com');
  });

  bot.command('sh', async (ctx) => {
    const command = ctx.message.text.replace('/sh', '').trim();
    if (!command) return ctx.reply('Please provide a command. e.g., /sh ls -la');
    ctx.reply(`Executing: ${command}`);
    const result = await executeShellCommand(command);
    return ctx.reply(`\`\`\`\n${result}\n\`\`\``, { parse_mode: 'Markdown' });
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;

    // Very basic interceptor for "remind me"
    // In a real implementation, we'd pass this to the LLM to extract intent & time.
    if (text.toLowerCase().includes('remind me')) {
      const scheduled = await handleScheduling(text, ctx);
      if (scheduled) return;
    }

    // Otherwise, normal conversation
    ctx.sendChatAction('typing');
    const response = await queryLLM([{ role: 'user', content: text }]);
    ctx.reply(response);
  });

  bot.on('voice', async (ctx) => {
    // TODO: implement voice downloading and Whisper transcription
    ctx.reply('Voice notes received. Transcription module pending implementation.');
  });

  bot.launch();
  console.log('Telegram bot started.');

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

module.exports = { startTelegramBot };

const { Telegraf } = require('telegraf');
const { queryLLM, parseResponse } = require('./llm');
const { updateConfig } = require('./config');
const { handleScheduling } = require('./scheduler');
const { connectToChromeAndLearn } = require('./browser');
const queue = require('./command-queue');

function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not found, skipping Telegram initialization.');
    return null;
  }

  const bot = new Telegraf(token);

  bot.command('model', (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length > 1) {
      const newModel = args[1];
      const valid = ['openai', 'anthropic', 'gemini', 'mistral', 'grok', 'kimi', 'ollama'];
      if (valid.includes(newModel)) {
        updateConfig({ activeModel: newModel });
        return ctx.reply(`Switched active provider to: ${newModel}`);
      }
      return ctx.reply(`Invalid provider. Choose from: ${valid.join(', ')}`);
    }
    return ctx.reply('Please specify a provider. e.g., /model gemini');
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

    // /sh proposes the command through the same approval flow
    const id = queue.enqueue(ctx.chat.id, command, 'Manually requested via /sh');
    return ctx.reply(
      `📋 *Command proposal*\n\n` +
      `_Reason:_ Manually requested via /sh\n` +
      `\`\`\`\n${command}\n\`\`\`\n\n` +
      `This will run on your host machine via the MinaClaw watcher.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Run it', callback_data: `approve:${id}` },
            { text: '❌ Cancel',  callback_data: `cancel:${id}`  },
          ]],
        },
      }
    );
  });

  // Inline keyboard responses
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    const [action, id] = data.split(':');

    if (action === 'approve') {
      // Command stays in the queue; the host CLI watcher will pick it up
      await ctx.answerCbQuery('Queued — waiting for host watcher.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text + '\n\n⏳ _Approved — waiting for host CLI watcher to execute…_',
        { parse_mode: 'Markdown' }
      );
    } else if (action === 'cancel') {
      queue.cancel(id);
      await ctx.answerCbQuery('Cancelled.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text + '\n\n❌ _Cancelled._',
        { parse_mode: 'Markdown' }
      );
    }
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;

    if (text.toLowerCase().includes('remind me')) {
      const scheduled = await handleScheduling(text, ctx);
      if (scheduled) return;
    }

    ctx.sendChatAction('typing');
    const raw = await queryLLM([{ role: 'user', content: text }]);
    const parsed = parseResponse(raw);

    if (parsed.type === 'command_proposal') {
      const id = queue.enqueue(ctx.chat.id, parsed.command, parsed.explanation);
      return ctx.reply(
        `📋 *Command proposal*\n\n` +
        `_Reason:_ ${parsed.explanation}\n` +
        `\`\`\`\n${parsed.command}\n\`\`\`\n\n` +
        `This will run on your host machine via the MinaClaw watcher.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Run it', callback_data: `approve:${id}` },
              { text: '❌ Cancel',  callback_data: `cancel:${id}`  },
            ]],
          },
        }
      );
    }

    ctx.reply(parsed.response);
  });

  bot.on('voice', async (ctx) => {
    ctx.reply('Voice notes received. Transcription module pending implementation.');
  });

  bot.launch();
  console.log('Telegram bot started.');

  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

module.exports = { startTelegramBot };

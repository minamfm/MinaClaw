const { Telegraf } = require('telegraf');
const { queryLLMLoop, parseResponse } = require('./llm');
const { updateConfig } = require('./config');
const { handleScheduling } = require('./scheduler');
const { connectToChromeAndLearn, learnFromDirectory } = require('./browser');
const queue   = require('./command-queue');
const session = require('./session');

function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not found, skipping Telegram initialization.');
    return null;
  }

  const bot = new Telegraf(token, { handlerTimeout: 300_000 });

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
      ctx.reply(`Connecting to Chrome to learn from ${url}…`);
      const result = await connectToChromeAndLearn(url);
      return ctx.reply(result);
    }
    return ctx.reply('Please specify a URL. e.g., /learn https://example.com');
  });

  bot.command('learn_dir', async (ctx) => {
    const relativePath = ctx.message.text.replace('/learn_dir', '').trim();
    if (!relativePath) {
      return ctx.reply('Please specify a path relative to /mnt/safe.\ne.g., /learn_dir home-dashboard');
    }
    ctx.reply(`📖 Reading source files in /mnt/safe/${relativePath}…`);
    const result = await learnFromDirectory(relativePath);
    return ctx.reply(result);
  });

  bot.command('sh', async (ctx) => {
    const command = ctx.message.text.replace('/sh', '').trim();
    if (!command) return ctx.reply('Please provide a command. e.g., /sh ls -la');

    const id = queue.enqueue(ctx.chat.id, command, 'Manually requested via /sh');
    return ctx.reply(
      `📋 *Command proposal*\n\n_Reason:_ Manually requested via /sh\n\`\`\`\n${command}\n\`\`\`\n\nThis will run on your host machine via the MinaClaw watcher.`,
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
    );
  });

  // Inline keyboard responses (approve / approve_all / cancel command proposals)
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    const [action, id] = data.split(':');

    if (action === 'approve') {
      queue.approve(id);
      await ctx.answerCbQuery('Approved — waiting for host watcher.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text + '\n\n⏳ _Approved — waiting for host CLI watcher to execute…_',
        { parse_mode: 'Markdown' }
      );
    } else if (action === 'approve_all') {
      const item = queue.getById(id);
      if (item) {
        queue.approveAll(item.chatId, item.command);
      } else {
        queue.approve(id);
      }
      await ctx.answerCbQuery('Always allowed this session.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text + '\n\n⚡ _Always allowed this session — queued for execution._',
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
    const text      = ctx.message.text;
    const sessionId = ctx.chat.id.toString();

    // Persist the user's chat ID so the agent can message them proactively
    updateConfig({ telegramChatId: ctx.chat.id });

    if (text.toLowerCase().includes('remind me')) {
      const scheduled = await handleScheduling(text, ctx);
      if (scheduled) return;
    }

    ctx.sendChatAction('typing');
    const typingInterval = setInterval(() => ctx.sendChatAction('typing'), 4000);
    session.append(sessionId, 'user', text);
    const { text: llmText, usage, parsed, newMessages } = await queryLLMLoop(session.get(sessionId));
    clearInterval(typingInterval);
    for (const msg of newMessages) session.append(sessionId, msg.role, msg.content);
    if (usage) session.addUsage(sessionId, usage.input, usage.output);

    if (parsed.type === 'send_telegram') {
      return ctx.reply(parsed.message);
    }

    if (parsed.type === 'command_proposal') {
      const id = queue.enqueue(ctx.chat.id, parsed.command, parsed.explanation);

      // Auto-approve if user previously said "always allow" for this command
      if (queue.isAutoApproved(ctx.chat.id, parsed.command)) {
        queue.approve(id);
        return ctx.reply(
          `⚡ *Auto-executing \\(pre\\-approved this session\\)*\n\`\`\`\n${parsed.command}\n\`\`\``,
          { parse_mode: 'MarkdownV2' }
        );
      }

      return ctx.reply(
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
      );
    }

    ctx.reply(parsed.response);
  });

  bot.on('voice', async (ctx) => {
    ctx.reply('Voice notes received. Transcription module pending implementation.');
  });

  const launchBot = () => {
    bot.launch().catch(err => {
      if (err.message && err.message.includes('409')) {
        console.warn('Telegram 409 conflict — another instance is still shutting down. Retrying in 5s…');
        setTimeout(launchBot, 5000);
      } else {
        console.error('Telegram bot error:', err.message);
      }
    });
  };
  launchBot();
  console.log('Telegram bot started.');

  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

module.exports = { startTelegramBot };

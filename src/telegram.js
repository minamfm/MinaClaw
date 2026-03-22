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
    await ctx.reply(`📖 Starting to read /mnt/safe/${relativePath}…`);
    const onProgress = (msg) => ctx.reply(msg);
    const result = await learnFromDirectory(relativePath, onProgress);
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
        ctx.callbackQuery.message.text + '\n\n⏳ Approved — waiting for host CLI watcher to execute…'
      ).catch(() => {});
    } else if (action === 'approve_all') {
      const item = queue.getById(id);
      if (item) {
        queue.approveAll(item.chatId, item.command);
      } else {
        queue.approve(id);
      }
      await ctx.answerCbQuery('Always allowed this session.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text + '\n\n⚡ Always allowed this session — queued for execution.'
      ).catch(() => {});
    } else if (action === 'cancel') {
      const item = queue.getById(id);
      queue.cancel(id);
      await ctx.answerCbQuery('Cancelled.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text + '\n\n❌ Cancelled.'
      ).catch(() => {});

      // Resume the agent so it can acknowledge the cancellation and continue
      if (item) {
        const sessionId = String(item.chatId);
        session.append(sessionId, 'user', `I cancelled the command proposal. Command: \`${item.command}\``);
        try {
          const { text, parsed, newMessages } = await queryLLMLoop(session.get(sessionId), { sessionId });
          for (const msg of newMessages) session.append(sessionId, msg.role, msg.content);
          const reply = (parsed?.type === 'text' ? parsed.response : null) || text;
          await bot.telegram.sendMessage(item.chatId, reply).catch(() => {});
        } catch (err) {
          console.error('[cancel-resume] LLM error:', err.message);
        }
      }
    }
  });

  const LIMIT_FALLBACK = 'I ran too many internal commands trying to answer that. Please ask me to continue.';

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

    // Progress message — created on first tool call, edited on each subsequent one
    let progressMsgId = null;
    let progressLines = [];
    let progressSent  = false;
    let workingTimer;

    const onProgress = async (label) => {
      progressSent = true;
      clearTimeout(workingTimer);
      progressLines.push(`${progressLines.length + 1}. ${label}`);
      const body = '⚙️ Working...\n\n' + progressLines.join('\n');
      if (!progressMsgId) {
        const msg = await ctx.reply(body).catch(() => null);
        if (msg) progressMsgId = msg.message_id;
      } else {
        await ctx.telegram.editMessageText(ctx.chat.id, progressMsgId, null, body).catch(() => {});
      }
    };

    // Streaming message — created on first text chunk, edited every 2 sentence endings
    let streamMsgId   = null;
    let streamCreating = false;
    let streamText    = '';
    let streamPeriods = 0;
    let streamLastEdit = 0;

    const onChunk = (accumulated) => {
      // Detect a new LLM step (accumulation reset to short text)
      if (accumulated.length < streamText.length) { streamText = ''; streamPeriods = 0; }

      const newEndings = Math.max(0,
        (accumulated.match(/[.!?]/g) || []).length - (streamText.match(/[.!?]/g) || []).length);
      streamPeriods += newEndings;
      streamText = accumulated;

      const now = Date.now();

      if (!streamMsgId && !streamCreating && accumulated.length >= 30) {
        streamCreating = true;
        ctx.reply(accumulated).then(msg => {
          if (msg) { streamMsgId = msg.message_id; streamLastEdit = Date.now(); streamPeriods = 0; }
          streamCreating = false;
        }).catch(() => { streamCreating = false; });
        return;
      }

      if (streamMsgId && (streamPeriods >= 2 || (now - streamLastEdit) >= 3000) && (now - streamLastEdit) >= 800) {
        ctx.telegram.editMessageText(ctx.chat.id, streamMsgId, null, accumulated).catch(() => {});
        streamLastEdit = now;
        streamPeriods = 0;
      }
    };

    // After 5s with no tool calls and no streaming, send a generic reassurance
    workingTimer = setTimeout(async () => {
      if (!progressSent && !streamMsgId) {
        await ctx.reply('⏳ Working on it…').catch(() => {});
      }
    }, 5_000);

    // Check for resumption context: tool call limit hit OR crash mid-task
    const history   = session.get(sessionId);
    const lastAsst  = [...history].reverse().find(m => m.role === 'assistant');
    const resuming  = lastAsst?.content === LIMIT_FALLBACK;
    const thinking  = session.getThinking(sessionId);

    session.append(sessionId, 'user', text);
    let messages = session.get(sessionId);

    if (resuming || thinking) {
      const hint = thinking
        ? `\n\n[Previous progress:\n${thinking}\n\nResume from where you left off until fully complete.]`
        : '\n\n[You previously hit the tool call limit. Review the conversation history above and resume until fully complete.]';
      messages = [...messages.slice(0, -1), { role: 'user', content: `${text}${hint}` }];
      // Crash recovery: clear thinking now — the loop will re-create it if needed
      if (thinking && !resuming) session.clearThinking(sessionId);
    }

    try {
      const { text: llmText, usage, parsed, newMessages, hitLimit } = await queryLLMLoop(messages, { onProgress, onChunk, sessionId });
      clearInterval(typingInterval);
      clearTimeout(workingTimer);

      // Update the progress message to final state
      if (progressMsgId) {
        const status   = hitLimit ? '⚠️ Hit tool call limit — say "continue" to resume' : '✅ Done';
        const finalBody = `${status}\n\n` + progressLines.join('\n');
        await ctx.telegram.editMessageText(ctx.chat.id, progressMsgId, null, finalBody).catch(() => {});
      }

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

      const finalText = (parsed.response || llmText || '').trim();
      if (!finalText) {
        // Model returned empty text (e.g. only memory tags) — don't send a blank message
        console.warn('[bot] empty finalText, skipping reply');
      } else if (streamMsgId) {
        // Finalize the streaming message with the complete, clean text
        ctx.telegram.editMessageText(ctx.chat.id, streamMsgId, null, finalText).catch(() => {
          ctx.reply(finalText); // fallback if the message is too old to edit
        });
      } else {
        ctx.reply(finalText);
      }
    } catch (err) {
      clearInterval(typingInterval);
      clearTimeout(workingTimer);
      console.error('Bot handler error:', err);
      ctx.reply('Sorry, something went wrong on my end. Please try again.').catch(() => {});
    }
  });

  bot.on('voice', async (ctx) => {
    ctx.reply('Voice notes received. Transcription module pending implementation.');
  });

  let launchDelay = 5000;
  const launchBot = () => {
    bot.launch().catch(err => {
      const msg = err.message || '';
      if (msg.includes('409')) {
        console.warn('Telegram 409 conflict — another instance is still shutting down. Retrying in 5s…');
        launchDelay = 5000;
      } else {
        console.error(`Telegram bot error: ${msg} — retrying in ${launchDelay / 1000}s…`);
        launchDelay = Math.min(launchDelay * 2, 60000); // exponential backoff, cap at 60s
      }
      setTimeout(launchBot, launchDelay);
    });
  };
  launchBot();
  console.log('Telegram bot started.');

  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

module.exports = { startTelegramBot };

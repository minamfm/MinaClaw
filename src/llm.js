const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const { loadConfig } = require('./config');
const { loadMemoryContext, extractMemoryTags, appendMemory, replaceIdentity } = require('./memory');
const { executeShellCommand } = require('./tools');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Kimi (Moonshot) — OpenAI-compatible
const kimi = new OpenAI({
  apiKey: process.env.KIMI_API_KEY,
  baseURL: 'https://api.moonshot.cn/v1',
});

// Mistral — OpenAI-compatible
const mistral = new OpenAI({
  apiKey: process.env.MISTRAL_API_KEY,
  baseURL: 'https://api.mistral.ai/v1',
});

// xAI Grok — OpenAI-compatible
const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function parseResponse(text) {
  // 1. Clean fences and try the whole string (well-behaved models)
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  if (cleaned.startsWith('{')) {
    try {
      const json = JSON.parse(cleaned);
      if (json.type === 'command_proposal' && json.command) return json;
      if (json.type === 'internal_exec'    && json.command) return json;
      if (json.type === 'send_telegram'    && json.message) return json;
    } catch { /* fall through */ }
  }
  // 2. Search anywhere in the text — handles preamble/postamble the model added
  const match = text.match(/\{[\s\S]*?"type"\s*:\s*"(?:command_proposal|internal_exec|send_telegram)"[\s\S]*?\}/);
  if (match) {
    try {
      const json = JSON.parse(match[0]);
      if (json.type === 'command_proposal' && json.command) return json;
      if (json.type === 'internal_exec'    && json.command) return json;
      if (json.type === 'send_telegram'    && json.message) return json;
    } catch { /* fall through */ }
  }
  return { type: 'text', response: text };
}

// Returns { text, usage: { input, output } | null, model }
async function queryLLM(messages) {
  const config      = loadConfig();
  const activeModel = config.activeModel;
  const modelName   = (config.models && config.models[activeModel]) || activeModel;

  // Inject persistent memory into the system prompt on every call
  const memoryContext = loadMemoryContext();
  const sysPrompt = memoryContext
    ? `${config.systemPrompt}\n\n---\n\n${memoryContext}`
    : config.systemPrompt;

  const fullMessages = [
    { role: 'system', content: sysPrompt },
    ...messages,
  ];

  let result; // { raw, usage }
  try {
    switch (activeModel) {
      case 'openai':    result = await queryOpenAI(fullMessages, modelName);               break;
      case 'kimi':      result = await queryKimi(fullMessages, modelName);                 break;
      case 'gemini':    result = await queryGemini(fullMessages, modelName);               break;
      case 'ollama':    result = await queryOllama(fullMessages, modelName);               break;
      case 'anthropic': result = await queryAnthropic(fullMessages, modelName, sysPrompt); break;
      case 'mistral':   result = await queryMistral(fullMessages, modelName);              break;
      case 'grok':      result = await queryGrok(fullMessages, modelName);                 break;
      default:          throw new Error(`Unknown provider: ${activeModel}`);
    }
  } catch (err) {
    console.error(`LLM Error (${activeModel}/${modelName}):`, err);
    return { text: `Error communicating with ${activeModel}: ${err.message}`, usage: null, model: modelName };
  }

  // Strip memory tags before the response reaches any caller; persist them silently
  const { cleanText, remember, identity } = extractMemoryTags(result.raw);
  if (remember) appendMemory(remember).catch(e => console.error('Memory write failed:', e));
  if (identity) replaceIdentity(identity).catch(e => console.error('Identity write failed:', e));

  return { text: cleanText, usage: result.usage, model: modelName };
}

async function queryOpenAI(messages, model) {
  const response = await openai.chat.completions.create({ model, messages });
  return {
    raw:   response.choices[0].message.content,
    usage: { input: response.usage.prompt_tokens, output: response.usage.completion_tokens },
  };
}

async function queryKimi(messages, model) {
  const response = await kimi.chat.completions.create({ model, messages });
  return {
    raw:   response.choices[0].message.content,
    usage: { input: response.usage.prompt_tokens, output: response.usage.completion_tokens },
  };
}

async function queryMistral(messages, model) {
  const response = await mistral.chat.completions.create({ model, messages });
  return {
    raw:   response.choices[0].message.content,
    usage: { input: response.usage.prompt_tokens, output: response.usage.completion_tokens },
  };
}

async function queryGrok(messages, model) {
  const response = await grok.chat.completions.create({ model, messages });
  return {
    raw:   response.choices[0].message.content,
    usage: { input: response.usage.prompt_tokens, output: response.usage.completion_tokens },
  };
}

async function queryAnthropic(messages, model, sysPrompt) {
  // Anthropic separates the system prompt from the message list
  const chatMessages = messages.filter(m => m.role !== 'system');
  const response = await anthropic.messages.create({
    model,
    max_tokens: 8096,
    system: sysPrompt,
    messages: chatMessages,
  });
  return {
    raw:   response.content[0].text,
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

async function queryGemini(messages, model) {
  // Gemini maps 'system'/'user' → 'user', 'assistant' → 'model'
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const response = await gemini.models.generateContent({ model, contents });
  const meta = response.usageMetadata;
  return {
    raw:   response.text,
    usage: meta ? { input: meta.promptTokenCount, output: meta.candidatesTokenCount } : null,
  };
}

async function queryOllama(messages, model) {
  const url = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
  try {
    const response = await axios.post(
      `${url}/api/chat`,
      { model, messages, stream: false, think: false, keep_alive: '2h' },
      { timeout: 600_000 },
    );
    return {
      raw:   response.data.message.content,
      usage: {
        input:  response.data.prompt_eval_count || 0,
        output: response.data.eval_count        || 0,
      },
    };
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      // Ollama is likely bound to 127.0.0.1 only and can't be reached from Docker.
      // Return a self-healing command proposal so the user can fix it with one click.
      return {
        raw: JSON.stringify({
          type: 'command_proposal',
          explanation: `Ollama isn't reachable at ${url}. It's bound to 127.0.0.1 only and can't be reached from inside the agent container. This command reconfigures Ollama to accept connections from Docker and restarts it.`,
          command: `sudo mkdir -p /etc/systemd/system/ollama.service.d && printf '[Service]\\nEnvironment="OLLAMA_HOST=0.0.0.0"\\n' | sudo tee /etc/systemd/system/ollama.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart ollama`,
        }),
        usage: null,
      };
    }
    throw err;
  }
}

/**
 * Wraps queryLLM with an internal_exec tool loop.
 * When the LLM responds with {"type":"internal_exec","command":"..."}, the command
 * is executed inside the container immediately (no user approval), and its output
 * is fed back to the LLM so it can continue. Loops up to MAX_STEPS times.
 *
 * Returns { text, usage, model, parsed, newMessages } where newMessages contains
 * all intermediate + final assistant messages (and tool output user messages) to
 * be appended to the session by the caller.
 */
async function queryLLMLoop(messages) {
  const MAX_STEPS = 8;
  let msgs = [...messages];
  const newMessages = [];
  let totalUsage = null;
  let lastModel  = '';

  for (let i = 0; i < MAX_STEPS; i++) {
    const result = await queryLLM(msgs);
    lastModel = result.model;
    if (result.usage) {
      if (!totalUsage) totalUsage = { input: 0, output: 0 };
      totalUsage.input  += result.usage.input;
      totalUsage.output += result.usage.output;
    }

    const parsed = parseResponse(result.text);

    if (parsed.type !== 'internal_exec') {
      newMessages.push({ role: 'assistant', content: result.text });
      return { text: result.text, usage: totalUsage, model: lastModel, parsed, newMessages };
    }

    // Execute inside the container — no user approval required
    console.log(`[internal_exec] ${parsed.command}`);
    const output = await executeShellCommand(parsed.command);
    const outputMsg = `\`${parsed.command}\` output:\n\`\`\`\n${output}\n\`\`\``;

    newMessages.push({ role: 'assistant', content: result.text });
    newMessages.push({ role: 'user',      content: outputMsg });
    msgs = [...msgs,
      { role: 'assistant', content: result.text },
      { role: 'user',      content: outputMsg },
    ];
  }

  const fallback = 'I ran too many internal commands trying to answer that. Please ask me to continue.';
  newMessages.push({ role: 'assistant', content: fallback });
  return { text: fallback, usage: totalUsage, model: lastModel, parsed: { type: 'text', response: fallback }, newMessages };
}

module.exports = { queryLLM, queryLLMLoop, parseResponse };

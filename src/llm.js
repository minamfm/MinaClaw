const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const { loadConfig } = require('./config');
const { loadMemoryContext, extractMemoryTags, appendMemory, replaceIdentity } = require('./memory');
const { executeShellCommand } = require('./tools');
const { fetchUrl, searchWeb } = require('./web-tools');

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

// ─── Native tool definitions (OpenAI + Anthropic) ────────────────────────────

const TOOL_DEFS = [
  {
    name: 'internal_exec',
    description: 'Execute a shell command inside the agent container immediately — no approval needed. Use for reading files, processing data, any task achievable within the container. Always prefer this over command_proposal.',
    params: {
      command: { type: 'string', description: 'Shell command to execute' },
    },
    required: ['command'],
  },
  {
    name: 'fetch_url',
    description: 'Fetch any URL and return its content. Use for REST APIs, web pages, documentation, or any HTTP request.',
    params: {
      url:     { type: 'string', description: 'URL to fetch' },
      method:  { type: 'string', description: 'HTTP method (default: GET)' },
      headers: { type: 'object', description: 'Optional request headers', additionalProperties: { type: 'string' } },
      body:    { type: 'string', description: 'Optional request body' },
    },
    required: ['url'],
  },
  {
    name: 'search_web',
    description: 'Search the web and return top results with titles, URLs, and descriptions. Use for current events, news, or any information lookup.',
    params: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
  {
    name: 'command_proposal',
    description: 'Propose a command to run on the HOST machine — requires user approval. LAST RESORT ONLY: use only when the task cannot be done with internal_exec, fetch_url, or search_web (e.g. installing host software, sudo operations).',
    params: {
      command:     { type: 'string', description: 'The exact command to run on the host' },
      explanation: { type: 'string', description: 'One sentence: what it does and why it needs host access' },
    },
    required: ['command', 'explanation'],
  },
  {
    name: 'send_telegram',
    description: 'Send a Telegram message to the user.',
    params: {
      message: { type: 'string', description: 'Message to send' },
    },
    required: ['message'],
  },
];

const OPENAI_TOOLS = TOOL_DEFS.map(t => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: { type: 'object', properties: t.params, required: t.required },
  },
}));

const ANTHROPIC_TOOLS = TOOL_DEFS.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: { type: 'object', properties: t.params, required: t.required },
}));

// ─── Response parser (for non-native providers) ───────────────────────────────

function parseResponse(text) {
  // 1. Clean fences and try the whole string (well-behaved models)
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  if (cleaned.startsWith('{')) {
    try {
      const json = JSON.parse(cleaned);
      if (json.type === 'command_proposal' && json.command) return json;
      if (json.type === 'internal_exec'    && json.command) return json;
      if (json.type === 'send_telegram'    && json.message) return json;
      if (json.type === 'fetch_url'        && json.url)     return json;
      if (json.type === 'search_web'       && json.query)   return json;
    } catch { /* fall through */ }
  }
  // 2. Search anywhere in the text — handles preamble/postamble the model added
  const TYPES = 'command_proposal|internal_exec|send_telegram|fetch_url|search_web';
  const match = text.match(new RegExp(`\\{[\\s\\S]*?"type"\\s*:\\s*"(?:${TYPES})"[\\s\\S]*?\\}`));
  if (match) {
    try {
      const json = JSON.parse(match[0]);
      if (json.type === 'command_proposal' && json.command) return json;
      if (json.type === 'internal_exec'    && json.command) return json;
      if (json.type === 'send_telegram'    && json.message) return json;
      if (json.type === 'fetch_url'        && json.url)     return json;
      if (json.type === 'search_web'       && json.query)   return json;
    } catch { /* fall through */ }
  }
  return { type: 'text', response: text };
}

// ─── Provider query functions ─────────────────────────────────────────────────

// Returns { raw, usage, nativeToolCall? }
// nativeToolCall: { provider, toolCallId, assistantMsg (OpenAI) | assistantContent (Anthropic) }
async function queryOpenAI(messages, model) {
  const response = await openai.chat.completions.create({
    model,
    messages,
    tools: OPENAI_TOOLS,
    tool_choice: 'auto',
  });

  const choice = response.choices[0];
  const usage  = { input: response.usage.prompt_tokens, output: response.usage.completion_tokens };

  if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
    const tc = choice.message.tool_calls[0];
    let args = {};
    try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
    return {
      raw: JSON.stringify({ type: tc.function.name, ...args }),
      usage,
      nativeToolCall: { provider: 'openai', toolCallId: tc.id, assistantMsg: choice.message },
    };
  }

  return { raw: choice.message.content || '', usage };
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
  const chatMessages = messages.filter(m => m.role !== 'system');
  const response = await anthropic.messages.create({
    model,
    max_tokens: 8096,
    system: sysPrompt,
    tools: ANTHROPIC_TOOLS,
    messages: chatMessages,
  });

  const usage = { input: response.usage.input_tokens, output: response.usage.output_tokens };

  if (response.stop_reason === 'tool_use') {
    const toolUse = response.content.find(b => b.type === 'tool_use');
    if (toolUse) {
      return {
        raw: JSON.stringify({ type: toolUse.name, ...toolUse.input }),
        usage,
        nativeToolCall: { provider: 'anthropic', toolCallId: toolUse.id, assistantContent: response.content },
      };
    }
  }

  const textBlock = response.content.find(b => b.type === 'text');
  return { raw: textBlock?.text || '', usage };
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

// ─── queryLLM ─────────────────────────────────────────────────────────────────

// Returns { text, usage, model, nativeToolCall? }
async function queryLLM(messages) {
  const config      = loadConfig();
  const activeModel = config.activeModel;
  const modelName   = (config.models && config.models[activeModel]) || activeModel;

  const memoryContext = loadMemoryContext();
  const sysPrompt = memoryContext
    ? `${config.systemPrompt}\n\n---\n\n${memoryContext}`
    : config.systemPrompt;

  const fullMessages = [
    { role: 'system', content: sysPrompt },
    ...messages,
  ];

  let result;
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

  // Strip memory tags silently
  const { cleanText, remember, identity } = extractMemoryTags(result.raw);
  if (remember) appendMemory(remember).catch(e => console.error('Memory write failed:', e));
  if (identity) replaceIdentity(identity).catch(e => console.error('Identity write failed:', e));

  return { text: cleanText, usage: result.usage, model: modelName, nativeToolCall: result.nativeToolCall || null };
}

// ─── queryLLMLoop ─────────────────────────────────────────────────────────────

/**
 * Runs the LLM in a tool loop.
 * - For OpenAI and Anthropic: uses native function calling (reliable).
 * - For other providers: falls back to JSON-in-text parsing.
 *
 * msgs:        working message array for LLM calls (may contain native tool formats)
 * newMessages: simple text format only — safe to persist to session across provider changes
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

    const TOOL_TYPES = ['internal_exec', 'fetch_url', 'search_web'];
    if (!TOOL_TYPES.includes(parsed.type)) {
      newMessages.push({ role: 'assistant', content: result.text });
      return { text: result.text, usage: totalUsage, model: lastModel, parsed, newMessages };
    }

    // Execute tool
    let output;
    if (parsed.type === 'internal_exec') {
      console.log(`[internal_exec] ${parsed.command}`);
      output = await executeShellCommand(parsed.command);
    } else if (parsed.type === 'fetch_url') {
      console.log(`[fetch_url] ${parsed.method || 'GET'} ${parsed.url}`);
      output = await fetchUrl(parsed.url, parsed.method, parsed.headers, parsed.body);
    } else if (parsed.type === 'search_web') {
      console.log(`[search_web] ${parsed.query}`);
      output = await searchWeb(parsed.query);
    }

    const label = parsed.type === 'internal_exec' ? `\`${parsed.command}\``
                : parsed.type === 'fetch_url'     ? `fetch ${parsed.url}`
                : `search "${parsed.query}"`;
    const outputMsg = `${label} result:\n\`\`\`\n${output}\n\`\`\``;

    // Session persistence — always simple text
    newMessages.push({ role: 'assistant', content: result.text });
    newMessages.push({ role: 'user',      content: outputMsg });

    // Working messages — use native format for OpenAI/Anthropic, text for others
    const ntc = result.nativeToolCall;
    if (ntc?.provider === 'openai') {
      msgs = [...msgs,
        ntc.assistantMsg,
        { role: 'tool', tool_call_id: ntc.toolCallId, content: output },
      ];
    } else if (ntc?.provider === 'anthropic') {
      msgs = [...msgs,
        { role: 'assistant', content: ntc.assistantContent },
        { role: 'user',      content: [{ type: 'tool_result', tool_use_id: ntc.toolCallId, content: output }] },
      ];
    } else {
      msgs = [...msgs,
        { role: 'assistant', content: result.text },
        { role: 'user',      content: outputMsg },
      ];
    }
  }

  const fallback = 'I ran too many internal commands trying to answer that. Please ask me to continue.';
  newMessages.push({ role: 'assistant', content: fallback });
  return { text: fallback, usage: totalUsage, model: lastModel, parsed: { type: 'text', response: fallback }, newMessages };
}

module.exports = { queryLLM, queryLLMLoop, parseResponse };

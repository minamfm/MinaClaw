const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const { loadConfig } = require('./config');
const { loadMemoryContext, extractMemoryTags, appendMemory, replaceIdentity } = require('./memory');
const { executeShellCommand, updateAgentConfig } = require('./tools');
const { fetchUrl, searchWeb } = require('./web-tools');
const session = require('./session');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Kimi (Moonshot) — OpenAI-compatible
const kimi = new OpenAI({
  apiKey: process.env.KIMI_API_KEY,
  baseURL: 'https://api.moonshot.ai/v1',
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
  {
    name: 'update_config',
    description: 'Update the agent\'s own configuration. Use target="config" for runtime settings (activeModel, model names), target="env" for secrets that require a daemon restart (TELEGRAM_BOT_TOKEN, API keys).',
    params: {
      target: { type: 'string', description: '"config" for config.json settings, "env" for .env secrets' },
      key:    { type: 'string', description: 'Setting name. Config keys: activeModel, models.ollama, models.openai, etc. Env keys: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, etc.' },
      value:  { type: 'string', description: 'New value to set' },
    },
    required: ['target', 'key', 'value'],
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

/**
 * Walks `text` looking for the first well-formed JSON object that contains a
 * recognised "type" field.  Uses brace-depth + string-escape tracking so it
 * correctly handles nested objects and JSON-in-strings (e.g. a "body" field
 * whose value is a serialised JSON string containing its own { } braces).
 * The old regex approach stopped at the first } it found, which broke any
 * tool call that included a nested object such as "headers":{…}.
 */
function extractToolJson(text) {
  const VALID = new Set(['command_proposal','internal_exec','send_telegram','fetch_url','search_web','update_config']);
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc)                  { esc = false; continue; }
      if (c === '\\' && inStr)  { esc = true;  continue; }
      if (c === '"')            { inStr = !inStr; continue; }
      if (inStr)                continue;
      if (c === '{')            depth++;
      if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            const json = JSON.parse(text.slice(i, j + 1));
            if (VALID.has(json.type)) return json;
          } catch { /* malformed — try next { */ }
          break;
        }
      }
    }
  }
  return null;
}

function isValidTool(json) {
  if (!json) return false;
  if (json.type === 'command_proposal' && json.command)              return true;
  if (json.type === 'internal_exec'    && json.command)              return true;
  if (json.type === 'send_telegram'    && json.message)              return true;
  if (json.type === 'fetch_url'        && json.url)                  return true;
  if (json.type === 'search_web'       && json.query)                return true;
  if (json.type === 'update_config'    && json.target && json.key)   return true;
  return false;
}

function parseResponse(text) {
  // 1. Clean fences and try the whole string (well-behaved models)
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  if (cleaned.startsWith('{')) {
    try {
      const json = JSON.parse(cleaned);
      if (isValidTool(json)) return json;
    } catch { /* fall through */ }
  }
  // 2. Depth-aware extraction — handles nested objects and JSON-in-strings
  const json = extractToolJson(text);
  if (isValidTool(json)) return json;

  // 3. Qwen3 / generic <tool_call>JSON</tool_call> format
  const toolCallMatch = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (toolCallMatch) {
    try {
      const inner = JSON.parse(toolCallMatch[1]);
      // Qwen format: { name: "...", arguments: {...} }
      const mapped = inner.name ? { type: inner.name, ...(inner.arguments || {}) } : inner;
      if (isValidTool(mapped)) return { ...mapped, _xmlFallback: true };
    } catch { /* fall through */ }
  }

  // 4. <action>tool</action> <content>param</content> — seen with Qwen3-Coder
  const actionMatch = text.match(/<action>\s*(\w+)\s*<\/action>\s*(?:<content>|<input>)\s*([\s\S]*?)\s*(?:<\/content>|<\/input>)/i);
  if (actionMatch) {
    const tool = actionMatch[1].trim();
    const param = actionMatch[2].trim();
    const xmlMapped = {
      fetch_url:    () => ({ type: 'fetch_url',    url: param }),
      internal_exec:() => ({ type: 'internal_exec', command: param }),
      search_web:   () => ({ type: 'search_web',   query: param }),
      send_telegram:() => ({ type: 'send_telegram', message: param }),
      command_proposal: () => ({ type: 'command_proposal', command: param, explanation: 'Requested via tool call' }),
    }[tool];
    if (xmlMapped) {
      const result = xmlMapped();
      if (isValidTool(result)) return { ...result, _xmlFallback: true };
    }
  }

  return { type: 'text', response: text };
}

// ─── Provider query functions ─────────────────────────────────────────────────
// All accept an optional onChunk(accumulatedText) callback for streaming.
// Returns { raw, usage, nativeToolCall? }

async function queryOpenAI(messages, model, onChunk, onThinking, signal) {
  // o-series reasoning models don't support parallel_tool_calls
  const isReasoning = /^o[1-9][\w-]*/i.test(model);

  const params = {
    model,
    messages,
    tools: OPENAI_TOOLS,
    tool_choice: 'auto',
    stream: true,
    stream_options: { include_usage: true },
    ...(isReasoning ? {} : { parallel_tool_calls: false }),
  };

  const stream = await openai.chat.completions.create(params, { signal });

  let text = '', thinking = '', toolCallId = '', toolCallName = '', toolCallArgs = '';
  let isToolCall = false;
  let usage = { input: 0, output: 0 };

  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
    }
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
    if (delta.reasoning_content) {
      thinking += delta.reasoning_content;
      if (onThinking) onThinking(thinking);
    }
    if (delta.tool_calls?.length) {
      isToolCall = true;
      const tc = delta.tool_calls[0];
      if (tc.id)                  toolCallId   += tc.id;
      if (tc.function?.name)      toolCallName += tc.function.name;
      if (tc.function?.arguments) toolCallArgs += tc.function.arguments;
    } else if (delta.content) {
      text += delta.content;
      if (onChunk) onChunk(text);
    }
  }

  if (isToolCall) {
    let args = {};
    try { args = JSON.parse(toolCallArgs); } catch { /* ignore */ }
    return {
      raw: JSON.stringify({ type: toolCallName, ...args }),
      usage,
      nativeToolCall: {
        provider: 'openai',
        toolCallId,
        assistantMsg: {
          role: 'assistant', content: null,
          tool_calls: [{ id: toolCallId, type: 'function',
            function: { name: toolCallName, arguments: toolCallArgs } }],
        },
      },
    };
  }
  return { raw: text, usage };
}

// Shared streaming helper for OpenAI-compatible providers without native tool calling
async function queryOpenAICompat(client, messages, model, onChunk) {
  const stream = await client.chat.completions.create({ model, messages, stream: true });
  let text = '', usage = { input: 0, output: 0 };
  for await (const chunk of stream) {
    if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      text += delta;
      // Suppress streaming if the response looks like a JSON tool call
      if (onChunk && text.length > 40 && !text.trimStart().startsWith('{')) onChunk(text);
    }
  }
  return { raw: text, usage };
}

async function queryKimi(messages, model, onChunk) {
  const stream = await kimi.chat.completions.create({
    model, messages, stream: true,
    extra_body: { thinking: { type: 'disabled' } },
  });
  let text = '';
  let usage = { input: 0, output: 0 };
  for await (const chunk of stream) {
    if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      text += delta;
      if (onChunk && text.length > 40 && !text.trimStart().startsWith('{')) onChunk(text);
    }
  }
  return { raw: text, usage };
}
async function queryMistral(messages, model, onChunk) {
  return queryOpenAICompat(mistral, messages, model, onChunk);
}
async function queryGrok(messages, model, onChunk) {
  return queryOpenAICompat(grok, messages, model, onChunk);
}

async function queryAnthropic(messages, model, sysPrompt, onChunk) {
  const chatMessages = messages.filter(m => m.role !== 'system');
  const stream = anthropic.messages.stream({
    model,
    max_tokens: 8096,
    system: sysPrompt,
    tools: ANTHROPIC_TOOLS,
    messages: chatMessages,
  });

  let text = '', toolInputJson = '', toolUse = null;
  const assistantContent = [];
  let usage = { input: 0, output: 0 };

  for await (const event of stream) {
    if (event.type === 'message_start') {
      usage.input = event.message.usage.input_tokens;
    } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      toolUse = { id: event.content_block.id, name: event.content_block.name };
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        text += event.delta.text;
        if (onChunk) onChunk(text);
      } else if (event.delta.type === 'input_json_delta') {
        toolInputJson += event.delta.partial_json;
      }
    } else if (event.type === 'message_delta') {
      usage.output = event.usage?.output_tokens || 0;
      if (event.delta.stop_reason === 'tool_use' && toolUse) {
        let args = {};
        try { args = JSON.parse(toolInputJson); } catch { /* ignore */ }
        if (text) assistantContent.push({ type: 'text', text });
        assistantContent.push({ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: args });
        return {
          raw: JSON.stringify({ type: toolUse.name, ...args }),
          usage,
          nativeToolCall: { provider: 'anthropic', toolCallId: toolUse.id, assistantContent },
        };
      }
    }
  }
  return { raw: text, usage };
}

async function queryGemini(messages, model, onChunk) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const stream = await gemini.models.generateContentStream({ model, contents });
  let text = '', usage = null;
  for await (const chunk of stream) {
    const delta = chunk.text || '';
    if (delta) {
      text += delta;
      if (onChunk && text.length > 40 && !text.trimStart().startsWith('{')) onChunk(text);
    }
    if (chunk.usageMetadata) {
      usage = { input: chunk.usageMetadata.promptTokenCount, output: chunk.usageMetadata.candidatesTokenCount };
    }
  }
  return { raw: text, usage };
}

async function queryOllama(messages, model, onChunk, onThinking, signal) {
  const url = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';

  const streamRequest = async (body) => {
    const response = await axios.post(`${url}/api/chat`, body, { timeout: 600_000, responseType: 'stream', signal });
    return new Promise((resolve, reject) => {
      let buf = '', text = '', thinking = '', resolved = false;
      const safeResolve = (val) => { if (!resolved) { resolved = true; resolve(val); } };

      response.data.on('data', raw => {
        buf += raw.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let data; try { data = JSON.parse(line); } catch { continue; }
          if (data.message?.thinking) {
            thinking += data.message.thinking;
            if (onThinking) onThinking(thinking);
          }
          if (data.message?.content) {
            text += data.message.content;
            if (onChunk && text.length > 40 && !text.trimStart().startsWith('{')) onChunk(text);
          }
          if (data.done) {
            // Strip inline <think>…</think> blocks that some models embed in content,
            // route them to onThinking so the UI still shows them.
            let finalText = text;
            if (text.includes('<think>')) {
              finalText = text.replace(/<think>[\s\S]*?<\/think>/gi, (match) => {
                const thinkContent = match.replace(/<\/?think>/gi, '').trim();
                if (thinkContent) {
                  thinking += thinkContent;
                  if (onThinking) onThinking(thinking);
                }
                return '';
              }).trim();
            }

            if (finalText) console.log(`\n[ollama:think]\n${thinking}\n[/ollama:think]\n`);
            else if (thinking) console.log(`\n[ollama:think]\n${thinking}\n[/ollama:think]\n`);

            const inputTok = data.prompt_eval_count || 0;
            const outputTok = data.eval_count || 0;
            console.log(`[ollama:tokens] prompt=${inputTok} gen=${outputTok} model=${model}`);

            if (!finalText && thinking) {
              // Model generated thinking but no content — its chat template forces <think> → EOS
              // with no content phase. Use /api/generate (raw, no template) to extract the action.
              // Mark resolved=true NOW so the on('end') event doesn't race ahead with empty text.
              resolved = true;
              console.warn(`[ollama] content empty after thinking — extracting action via /api/generate`);
              // Signal telegram to freeze the thinking message while extraction runs
              if (onThinking) onThinking('🔄 Extracting action...');
              const extractPrompt = `You output a single JSON tool call and nothing else.

Tools:
{"type":"internal_exec","command":"SHELL_CMD"}
{"type":"fetch_url","url":"URL","method":"GET"}
{"type":"search_web","query":"QUERY"}
{"type":"update_config","target":"config","key":"KEY","value":"VAL"}
{"type":"send_telegram","message":"MSG"}

Example:
Reasoning: need to list files in /app
Output: {"type":"internal_exec","command":"ls /app"}

Reasoning: ${thinking.slice(-600)}
Output:`;
              axios.post(`${url}/api/generate`, {
                model, raw: true, stream: false, format: 'json',
                prompt: extractPrompt,
                options: { num_predict: 128, num_ctx: 4096 },
              }, { timeout: 120_000, signal }).then(r => {
                const extracted = (r.data?.response || '').trim();
                console.log(`[ollama] extracted action: ${extracted.slice(0, 200)}`);
                resolve({ raw: extracted || thinking, usage: { input: inputTok, output: outputTok + (r.data?.eval_count || 0) } });
              }).catch(err => {
                console.warn(`[ollama] action extraction failed: ${err.message}`);
                resolve({ raw: thinking, usage: { input: inputTok, output: outputTok } });
              });
            } else {
              safeResolve({ raw: finalText, usage: { input: inputTok, output: outputTok } });
            }
          }
        }
      });

      response.data.on('error', err => {
        if (signal?.aborted) {
          safeResolve({ raw: text, usage: { input: 0, output: 0 }, aborted: true });
        } else {
          reject(err);
        }
      });
      response.data.on('end', () => safeResolve({ raw: text, usage: { input: 0, output: 0 } }));
    });
  };

  const wantsThink = /qwen3|deepseek-r1|qwq/i.test(model);
  const baseBody = { model, messages, stream: true, keep_alive: '15m', think: wantsThink, options: { num_ctx: 20000, num_predict: -1 } };

  try {
    return await streamRequest(baseBody);
  } catch (err) {
    if (signal?.aborted) {
      return { raw: '', usage: null, aborted: true };
    }
    // Retry without think:true if the model doesn't support it
    if (wantsThink && err.response?.status === 400) {
      console.warn(`[ollama] think:true rejected for ${model}, retrying without it`);
      try {
        return await streamRequest(baseBody);
      } catch (retryErr) {
        err = retryErr;
      }
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      const isLocal = url.includes('host.docker.internal') || url.includes('localhost') || url.includes('127.0.0.1');
      const explanation = isLocal
        ? `Ollama isn't reachable at ${url}. It may be bound to 127.0.0.1 only. This command reconfigures Ollama to accept connections from Docker and restarts it.`
        : `Ollama isn't reachable at ${url}. Make sure the remote machine is running Ollama with OLLAMA_HOST=0.0.0.0 and that the port is accessible from this host.`;
      const command = isLocal
        ? `sudo mkdir -p /etc/systemd/system/ollama.service.d && printf '[Service]\\nEnvironment="OLLAMA_HOST=0.0.0.0"\\n' | sudo tee /etc/systemd/system/ollama.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart ollama`
        : `curl -s ${url}/api/tags | head -c 200`;
      return { raw: JSON.stringify({ type: 'command_proposal', explanation, command }), usage: null };
    }
    throw err;
  }
}

// ─── Compact system prompt for local/Ollama models ───────────────────────────
// The full system prompt is ~2000 tokens of verbose docs — too large for local
// models and causes GPU prefill to freeze the display. This version is ~200 tokens.

function buildOllamaSysPrompt(memoryContext) {
  const core = `\
You are a personal AI agent running on the user's machine. Be direct, casual, and helpful.

TOOLS — to use a tool emit ONLY the raw JSON object on its own line. No XML. No markdown. No <action> tags. No <tool_call> tags. Just the JSON:
{"type":"internal_exec","command":"..."}                                    — shell cmd in your container (no approval needed)
{"type":"fetch_url","url":"...","method":"GET","headers":{},"body":"..."}   — fetch URL / call API
{"type":"search_web","query":"..."}                                         — web search
{"type":"update_config","target":"config|env","key":"...","value":"..."}    — update agent settings
{"type":"command_proposal","command":"...","explanation":"..."}             — host command (needs user approval)
{"type":"send_telegram","message":"..."}                                    — send Telegram message

WRONG: <action>fetch_url</action><content>https://example.com</content>
RIGHT: {"type":"fetch_url","url":"https://example.com"}

Container: Alpine Linux, running as root. Available: bash, curl, wget, jq, git, python3, node. Install Python packages with: pip3 install --break-system-packages <pkg>  (the flag is required on Alpine).
Safe folders mounted at /mnt/safe. Config at /app/config. Skills at /app/skills.

SCRIPTS: Save runnable scripts to /app/skills/<name>.py (persistent volume). NEVER put code inside .md files — they are reference docs, not scripts. NEVER run python3 on a .md file. To run a script: check ls /app/skills/*.py first, then python3 /app/skills/<name>.py.

MEMORY: append <remember>note</remember> or replace <identity>full content</identity> at end of reply.
RULES: Never narrate tool use — just emit the JSON. Chain as many tool calls as needed.`;

  return memoryContext ? `${core}\n\n---\n\n${memoryContext}` : core;
}

// ─── queryLLM ─────────────────────────────────────────────────────────────────

// Returns { text, usage, model, nativeToolCall?, aborted? }
async function queryLLM(messages, { onChunk, onThinking, signal, sessionId } = {}) {
  const config      = loadConfig();
  const activeModel = config.activeModel;
  const modelName   = (config.models && config.models[activeModel]) || activeModel;

  const memoryContext = loadMemoryContext();
  const fullSysPrompt = memoryContext
    ? `${config.systemPrompt}\n\n---\n\n${memoryContext}`
    : config.systemPrompt;

  // Use a compact system prompt for Ollama to avoid GPU freeze during prefill
  const baseSysPrompt = activeModel === 'ollama'
    ? buildOllamaSysPrompt(memoryContext)
    : fullSysPrompt;

  // Append session channel context so the agent knows which channel it's on
  // and can route background notifications (notify.py --channel) correctly.
  let channelNote = '';
  if (sessionId) {
    if (sessionId.startsWith('wa:')) {
      channelNote = `\n\n[Session channel: WhatsApp | JID: ${sessionId.slice(3)}]`;
    } else {
      channelNote = `\n\n[Session channel: Telegram]`;
    }
  }
  const sysPrompt = channelNote ? baseSysPrompt + channelNote : baseSysPrompt;

  const fullMessages = [
    { role: 'system', content: sysPrompt },
    ...messages,
  ];

  let result;
  try {
    switch (activeModel) {
      case 'openai':    result = await queryOpenAI(fullMessages, modelName, onChunk, onThinking, signal); break;
      case 'kimi':      result = await queryKimi(fullMessages, modelName, onChunk);               break;
      case 'gemini':    result = await queryGemini(fullMessages, modelName, onChunk);               break;
      case 'ollama':    result = await queryOllama(fullMessages, modelName, onChunk, onThinking, signal); break;
      case 'anthropic': result = await queryAnthropic(fullMessages, modelName, sysPrompt, onChunk); break;
      case 'mistral':   result = await queryMistral(fullMessages, modelName, onChunk);              break;
      case 'grok':      result = await queryGrok(fullMessages, modelName, onChunk);                 break;
      default:          throw new Error(`Unknown provider: ${activeModel}`);
    }
  } catch (err) {
    if (signal?.aborted) {
      return { text: '', usage: null, model: modelName, aborted: true };
    }
    console.error(`LLM Error (${activeModel}/${modelName}):`, err);
    return { text: `Error communicating with ${activeModel}: ${err.message}`, usage: null, model: modelName, error: true };
  }

  if (result.aborted) return { text: '', usage: result.usage, model: modelName, aborted: true };

  // Strip memory tags silently
  const { cleanText, remember, identity } = extractMemoryTags(result.raw);
  if (remember) appendMemory(remember).catch(e => console.error('Memory write failed:', e));
  if (identity) replaceIdentity(identity).catch(e => console.error('Identity write failed:', e));

  return { text: cleanText, usage: result.usage, model: modelName, nativeToolCall: result.nativeToolCall || null };
}

// ─── Auto-compact ─────────────────────────────────────────────────────────────

const CONTEXT_WINDOW    = 20_000;
const COMPACT_AT_TOKENS = 8_000;  // compact early — keeps each request cheap
const TOOL_OUTPUT_CAP   = 1_500;  // chars stored per tool result in session history

function estimateTokens(msgs) {
  return msgs.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + Math.ceil(content.length / 4);
  }, 0);
}

async function compactHistory(msgs) {
  const transcript = msgs
    .map(m => `${m.role.toUpperCase()}:\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n\n---\n\n');
  const result = await queryLLM([{
    role: 'user',
    content: `Summarize this conversation concisely. Cover: decisions made, key facts established, tasks completed, user preferences, and any ongoing context needed to continue helping.\n\n${transcript}`,
  }]);
  return result.text;
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
async function queryLLMLoop(messages, { onProgress, onChunk, onThinking, signal, sessionId } = {}) {
  const MAX_STEPS  = 25;
  const WARN_STEP  = 22; // inject a wrap-up nudge before hard-stopping
  let msgs = [...messages];

  // Auto-compact when estimated token count approaches the context window limit
  if (estimateTokens(msgs) >= COMPACT_AT_TOKENS) {
    try {
      if (onProgress) await Promise.resolve(onProgress('Compacting session history…')).catch(() => {});
      console.log(`[compact] session=${sessionId} msgs=${msgs.length} ~${estimateTokens(msgs)} tokens — compacting`);
      const summary = await compactHistory(msgs);
      const keepLast = msgs.slice(-6); // keep last 3 exchanges verbatim for immediate continuity
      msgs = [
        { role: 'user',      content: `[Previous conversation summarized]\n\n${summary}` },
        { role: 'assistant', content: 'Got it — I have the summary of our previous conversation.' },
        ...keepLast,
      ];
      if (sessionId) session.save(sessionId, msgs);
      console.log(`[compact] done — reduced to ${msgs.length} messages`);
    } catch (err) {
      console.error('[compact] failed, continuing without compaction:', err.message);
    }
  }
  const newMessages = [];
  let totalUsage = null;
  let lastModel  = '';
  const steps = []; // for thinking.md
  const recentToolKeys = []; // for loop detection (last 6 tool call fingerprints)

  for (let i = 0; i < MAX_STEPS; i++) {
    // Nudge the agent to wrap up gracefully before hitting the hard limit
    if (i === WARN_STEP) {
      msgs = [...msgs, { role: 'user', content: 'You are close to the tool call limit. Wrap up what you have and give your final answer now — do not call any more tools.' }];
    }

    if (signal?.aborted) {
      if (sessionId) session.clearThinking(sessionId);
      return { text: '', usage: totalUsage, model: lastModel, parsed: { type: 'text', response: '' }, newMessages, aborted: true };
    }

    const result = await queryLLM(msgs, { onChunk, onThinking, signal, sessionId });
    lastModel = result.model;
    if (result.usage) {
      if (!totalUsage) totalUsage = { input: 0, output: 0 };
      totalUsage.input  += result.usage.input;
      totalUsage.output += result.usage.output;
    }

    // If aborted (new message from user), stop silently
    if (result.aborted) {
      if (sessionId) session.clearThinking(sessionId);
      return { text: '', usage: totalUsage, model: lastModel, parsed: { type: 'text', response: '' }, newMessages, aborted: true };
    }

    // If the LLM itself errored, surface it regardless of which step we're on
    if (result.error) {
      const text = i === 0
        ? `Sorry, I couldn't reach the AI model. ${result.text || 'Please try again.'}`
        : `I hit an error after ${i} step${i > 1 ? 's' : ''} and couldn't finish.\n\n${result.text}\n\nCompleted so far:\n${steps.map((s, j) => `${j + 1}. ${s.label}`).join('\n')}`;
      newMessages.push({ role: 'assistant', content: text });
      if (sessionId) session.clearThinking(sessionId);
      return { text, usage: totalUsage, model: lastModel, parsed: { type: 'text', response: text }, newMessages };
    }

    const parsed = parseResponse(result.text);

    const TOOL_TYPES = ['internal_exec', 'fetch_url', 'search_web', 'update_config'];

    // Planning-statement nudge — fires when the model narrates intent (e.g. "I'll schedule
    // that for you") instead of calling a tool. Inject a system correction and retry once.
    if (!TOOL_TYPES.includes(parsed.type) && i < 2 && !result.error) {
      const planRegex = /\b(I['']?ll|I will|I['']?m going to|let me|going to)\b[\s\S]{0,250}\b(schedule|remind|set (a |up )?timer|create (a )?reminder|turn (on|off)|run|execute|send|fetch|search|check|call)\b/i;
      if (planRegex.test(result.text)) {
        console.log(`[nudge] step=${i} — planning statement detected, nudging for tool call`);
        msgs = [...msgs,
          { role: 'assistant', content: result.text },
          { role: 'user', content: '[System: You described what you would do but did not call any tool. Call the appropriate tool now — no explanation, just the tool call.]' },
        ];
        newMessages.push({ role: 'assistant', content: result.text });
        continue;
      }
    }

    if (!TOOL_TYPES.includes(parsed.type)) {
      newMessages.push({ role: 'assistant', content: result.text });
      if (sessionId) session.clearThinking(sessionId);
      return { text: result.text, usage: totalUsage, model: lastModel, parsed, newMessages };
    }

    // Loop detection — two signals:
    // 1. Exact-same tool call repeated (original check)
    // 2. Many different tool calls all targeting the same script/URL (semantic loop)
    const rawTarget = parsed.url || parsed.command || parsed.query || parsed.key || '';
    const toolKey = parsed.type + ':' + rawTarget;
    // Semantic key: extract the core target (script path, hostname, etc.) to detect
    // "debugging spiral" where the model tries the same failing resource many ways.
    const semanticKey = parsed.type + ':' + (
      parsed.command ? (parsed.command.match(/\/app\/skills\/\S+\.py/) || parsed.command.match(/https?:\/\/[^/\s]+/))?.[0] || rawTarget.slice(0, 60)
                     : rawTarget.slice(0, 60)
    );
    recentToolKeys.push(semanticKey);
    if (recentToolKeys.length > 8) recentToolKeys.shift();
    const repeatCount = recentToolKeys.filter(k => k === semanticKey).length;
    if (repeatCount >= 4) {
      const loopText = `I kept hitting the same failure (${semanticKey}) across ${repeatCount} different attempts and stopped myself. This is likely a network, permissions, or environment issue rather than a script bug. Please check connectivity or provide more context.`;
      console.warn(`[loop-detect] semantic loop exit: ${semanticKey} (${repeatCount}x)`);
      newMessages.push({ role: 'assistant', content: loopText });
      if (sessionId) session.clearThinking(sessionId);
      return { text: loopText, usage: totalUsage, model: lastModel, parsed: { type: 'text', response: loopText }, newMessages };
    }
    // Exact repeat check (stricter — fires on 2nd repeat)
    const exactCount = recentToolKeys.filter(k => k === toolKey).length;
    if (exactCount >= 2) {
      const loopText = `I got stuck repeating the same tool call (\`${toolKey}\`) and stopped myself. I may not have enough information to complete this task — could you provide more context or clarify what you need?`;
      console.warn(`[loop-detect] forced exit on repeat: ${toolKey}`);
      newMessages.push({ role: 'assistant', content: loopText });
      if (sessionId) session.clearThinking(sessionId);
      return { text: loopText, usage: totalUsage, model: lastModel, parsed: { type: 'text', response: loopText }, newMessages };
    }

    // Execute tool
    let output;
    if (parsed.type === 'internal_exec') {
      console.log(`[internal_exec] ${parsed.command}`);
      output = await executeShellCommand(parsed.command, signal);
    } else if (parsed.type === 'fetch_url') {
      console.log(`[fetch_url] ${parsed.method || 'GET'} ${parsed.url}`);
      output = await fetchUrl(parsed.url, parsed.method, parsed.headers, parsed.body);
    } else if (parsed.type === 'search_web') {
      console.log(`[search_web] ${parsed.query}`);
      output = await searchWeb(parsed.query);
    } else if (parsed.type === 'update_config') {
      console.log(`[update_config] target=${parsed.target} key=${parsed.key}`);
      output = updateAgentConfig(parsed.target, parsed.key, parsed.value);
    }

    // Check abort immediately after tool execution — don't wait for next iteration
    if (signal?.aborted) {
      if (sessionId) session.clearThinking(sessionId);
      return { text: '', usage: totalUsage, model: lastModel, parsed: { type: 'text', response: '' }, newMessages, aborted: true };
    }

    const label = parsed.type === 'internal_exec' ? `\`${parsed.command}\``
                : parsed.type === 'fetch_url'     ? `fetch ${parsed.url}`
                : parsed.type === 'update_config' ? `config: ${parsed.key} = ${parsed.value}`
                : `search "${parsed.query}"`;

    // Progress notification (Telegram live update)
    if (onProgress) await Promise.resolve(onProgress(label)).catch(() => {});
    // Reset thinking display between tool steps — next step will create a fresh message
    if (onThinking) onThinking(null);

    // Save task state to disk so it survives daemon crashes or tool call limit hits
    if (sessionId) {
      steps.push({ label, snippet: output.slice(0, 150).replace(/\n/g, ' ') });
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
      session.updateThinking(sessionId, [
        '## Task In Progress',
        '',
        `**Prompt**: ${lastUserMsg.slice(0, 300)}`,
        '',
        `**Steps completed (${steps.length})**:`,
        ...steps.map((s, j) => `${j + 1}. ${s.label}  → ${s.snippet}`),
        '',
        '**Status**: IN PROGRESS — say "continue" to resume',
      ].join('\n'));
    }

    const formatReminder = parsed._xmlFallback
      ? `\n\n⚠️ FORMAT REMINDER: You used XML tags for that tool call. Always use plain JSON instead:\n{"type":"${parsed.type}","${parsed.url ? 'url":"' + parsed.url : parsed.command ? 'command":"' + parsed.command : 'query":"' + (parsed.query || '')}"}  — never use <action> or <tool_call> tags.`
      : '';
    // Truncate output stored in session history to keep context from bloating.
    // The full output is still used for the working messages sent to the LLM this turn.
    const storedOutput = output.length > TOOL_OUTPUT_CAP
      ? output.slice(0, TOOL_OUTPUT_CAP) + `\n… [truncated — ${output.length - TOOL_OUTPUT_CAP} chars omitted from history]`
      : output;
    const outputMsg       = `${label} result:\n\`\`\`\n${output}\n\`\`\`${formatReminder}`;
    const outputMsgStored = `${label} result:\n\`\`\`\n${storedOutput}\n\`\`\``;

    // Session persistence — always simple text
    newMessages.push({ role: 'assistant', content: result.text });
    newMessages.push({ role: 'user',      content: outputMsgStored });

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

  // Hit the hard limit — preserve thinking.md so the user can resume
  const fallback = 'I ran too many internal commands trying to answer that. Please ask me to continue.';
  newMessages.push({ role: 'assistant', content: fallback });
  return { text: fallback, usage: totalUsage, model: lastModel, parsed: { type: 'text', response: fallback }, newMessages, hitLimit: true };
}

async function transcribeVoice(buffer) {
  const { toFile } = require('openai');
  const file = await toFile(buffer, 'voice.ogg', { type: 'audio/ogg' });
  const result = await openai.audio.transcriptions.create({ file, model: 'whisper-1' });
  return result.text.trim();
}

module.exports = { queryLLM, queryLLMLoop, parseResponse, transcribeVoice };

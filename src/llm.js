const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const { loadConfig } = require('./config');
const { loadMemoryContext, extractMemoryTags, appendMemory, replaceIdentity } = require('./memory');
const { executeShellCommand } = require('./tools');
const { fetchUrl, searchWeb } = require('./web-tools');
const session = require('./session');

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
// All accept an optional onChunk(accumulatedText) callback for streaming.
// Returns { raw, usage, nativeToolCall? }

async function queryOpenAI(messages, model, onChunk) {
  const stream = await openai.chat.completions.create({
    model,
    messages,
    tools: OPENAI_TOOLS,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    stream: true,
    stream_options: { include_usage: true },
  });

  let text = '', toolCallId = '', toolCallName = '', toolCallArgs = '';
  let isToolCall = false;
  let usage = { input: 0, output: 0 };

  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
    }
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
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
  return queryOpenAICompat(kimi, messages, model, onChunk);
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

async function queryOllama(messages, model, onChunk) {
  const url = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
  try {
    const response = await axios.post(
      `${url}/api/chat`,
      Object.assign({ model, messages, stream: true, keep_alive: '2h' },
        /qwen3|deepseek-r1|qwq/i.test(model) ? { think: true } : {}),
      { timeout: 600_000, responseType: 'stream' },
    );

    return await new Promise((resolve, reject) => {
      let buf = '', text = '', thinking = '';

      response.data.on('data', raw => {
        buf += raw.toString();
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete line
        for (const line of lines) {
          if (!line.trim()) continue;
          let data; try { data = JSON.parse(line); } catch { continue; }
          if (data.message?.thinking) {
            thinking += data.message.thinking;
            if (onChunk) onChunk('💭 ' + thinking);
          }
          if (data.message?.content) {
            text += data.message.content;
            if (onChunk && text.length > 40 && !text.trimStart().startsWith('{')) onChunk(text);
          }
          if (data.done) {
            if (thinking) console.log(`\n[ollama:think]\n${thinking}\n[/ollama:think]\n`);
            resolve({ raw: text, usage: { input: data.prompt_eval_count || 0, output: data.eval_count || 0 } });
          }
        }
      });

      response.data.on('error', reject);
      // Fallback if done:true never arrives
      response.data.on('end', () => resolve({ raw: text, usage: { input: 0, output: 0 } }));
    });
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
async function queryLLM(messages, { onChunk } = {}) {
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
      case 'openai':    result = await queryOpenAI(fullMessages, modelName, onChunk);               break;
      case 'kimi':      result = await queryKimi(fullMessages, modelName, onChunk);                 break;
      case 'gemini':    result = await queryGemini(fullMessages, modelName, onChunk);               break;
      case 'ollama':    result = await queryOllama(fullMessages, modelName, onChunk);               break;
      case 'anthropic': result = await queryAnthropic(fullMessages, modelName, sysPrompt, onChunk); break;
      case 'mistral':   result = await queryMistral(fullMessages, modelName, onChunk);              break;
      case 'grok':      result = await queryGrok(fullMessages, modelName, onChunk);                 break;
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

// ─── Auto-compact ─────────────────────────────────────────────────────────────

const COMPACT_AT = 60; // message count threshold to trigger compaction

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
async function queryLLMLoop(messages, { onProgress, onChunk, sessionId } = {}) {
  const MAX_STEPS  = 25;
  const WARN_STEP  = 22; // inject a wrap-up nudge before hard-stopping
  let msgs = [...messages];

  // Auto-compact when conversation history grows too long
  if (msgs.length >= COMPACT_AT) {
    try {
      if (onProgress) await Promise.resolve(onProgress('Compacting session history…')).catch(() => {});
      console.log(`[compact] session=${sessionId} msgs=${msgs.length} — compacting`);
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

  for (let i = 0; i < MAX_STEPS; i++) {
    // Nudge the agent to wrap up gracefully before hitting the hard limit
    if (i === WARN_STEP) {
      msgs = [...msgs, { role: 'user', content: 'You are close to the tool call limit. Wrap up what you have and give your final answer now — do not call any more tools.' }];
    }

    const result = await queryLLM(msgs, { onChunk });
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
      if (sessionId) session.clearThinking(sessionId);
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

    // Progress notification (Telegram live update)
    if (onProgress) await Promise.resolve(onProgress(label)).catch(() => {});

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

  // Hit the hard limit — preserve thinking.md so the user can resume
  const fallback = 'I ran too many internal commands trying to answer that. Please ask me to continue.';
  newMessages.push({ role: 'assistant', content: fallback });
  return { text: fallback, usage: totalUsage, model: lastModel, parsed: { type: 'text', response: fallback }, newMessages, hitLimit: true };
}

module.exports = { queryLLM, queryLLMLoop, parseResponse };

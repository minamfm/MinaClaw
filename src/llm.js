const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const { loadConfig } = require('./config');
const { loadMemoryContext, extractMemoryTags, appendMemory, replaceIdentity } = require('./memory');

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
    } catch { /* fall through */ }
  }
  // 2. Search anywhere in the text — handles preamble/postamble the model added
  const match = text.match(/\{[\s\S]*?"type"\s*:\s*"command_proposal"[\s\S]*?\}/);
  if (match) {
    try {
      const json = JSON.parse(match[0]);
      if (json.type === 'command_proposal' && json.command) return json;
    } catch { /* fall through */ }
  }
  return { type: 'text', response: text };
}

async function queryLLM(messages) {
  const config     = loadConfig();
  const activeModel = config.activeModel;
  const modelName  = (config.models && config.models[activeModel]) || activeModel;

  // Inject persistent memory into the system prompt on every call
  const memoryContext = loadMemoryContext();
  const sysPrompt = memoryContext
    ? `${config.systemPrompt}\n\n---\n\n${memoryContext}`
    : config.systemPrompt;

  const fullMessages = [
    { role: 'system', content: sysPrompt },
    ...messages,
  ];

  let raw;
  try {
    switch (activeModel) {
      case 'openai':    raw = await queryOpenAI(fullMessages, modelName);               break;
      case 'kimi':      raw = await queryKimi(fullMessages, modelName);                 break;
      case 'gemini':    raw = await queryGemini(fullMessages, modelName);               break;
      case 'ollama':    raw = await queryOllama(fullMessages, modelName);               break;
      case 'anthropic': raw = await queryAnthropic(fullMessages, modelName, sysPrompt); break;
      case 'mistral':   raw = await queryMistral(fullMessages, modelName);              break;
      case 'grok':      raw = await queryGrok(fullMessages, modelName);                 break;
      default:          throw new Error(`Unknown provider: ${activeModel}`);
    }
  } catch (err) {
    console.error(`LLM Error (${activeModel}/${modelName}):`, err);
    return `Error communicating with ${activeModel}: ${err.message}`;
  }

  // Strip memory tags before the response reaches any caller; persist them silently
  const { cleanText, remember, identity } = extractMemoryTags(raw);
  if (remember) appendMemory(remember).catch(e => console.error('Memory write failed:', e));
  if (identity) replaceIdentity(identity).catch(e => console.error('Identity write failed:', e));

  return cleanText;
}

async function queryOpenAI(messages, model) {
  const response = await openai.chat.completions.create({ model, messages });
  return response.choices[0].message.content;
}

async function queryKimi(messages, model) {
  const response = await kimi.chat.completions.create({ model, messages });
  return response.choices[0].message.content;
}

async function queryMistral(messages, model) {
  const response = await mistral.chat.completions.create({ model, messages });
  return response.choices[0].message.content;
}

async function queryGrok(messages, model) {
  const response = await grok.chat.completions.create({ model, messages });
  return response.choices[0].message.content;
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
  return response.content[0].text;
}

async function queryGemini(messages, model) {
  // Gemini maps 'system'/'user' → 'user', 'assistant' → 'model'
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const response = await gemini.models.generateContent({ model, contents });
  return response.text;
}

async function queryOllama(messages, model) {
  const url = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
  try {
    const response = await axios.post(`${url}/api/chat`, { model, messages, stream: false });
    return response.data.message.content;
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      // Ollama is likely bound to 127.0.0.1 only and can't be reached from Docker.
      // Return a self-healing command proposal so the user can fix it with one click.
      return JSON.stringify({
        type: 'command_proposal',
        explanation: `Ollama isn't reachable at ${url}. It's bound to 127.0.0.1 only and can't be reached from inside the agent container. This command reconfigures Ollama to accept connections from Docker and restarts it.`,
        command: `sudo mkdir -p /etc/systemd/system/ollama.service.d && printf '[Service]\\nEnvironment="OLLAMA_HOST=0.0.0.0"\\n' | sudo tee /etc/systemd/system/ollama.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart ollama`,
      });
    }
    throw err;
  }
}

module.exports = { queryLLM, parseResponse };

const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const { loadConfig } = require('./config');

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

// Injected ahead of the user-defined system prompt so every provider supports
// command proposals without requiring manual system-prompt edits.
const COMMAND_CAPABILITY = `\
When the user's request would benefit from running a shell command on their system, \
respond ONLY with a JSON object in this exact format — no markdown fences, no other text:
{"type":"command_proposal","explanation":"one-sentence reason","command":"exact command to run"}
The command will be shown to the user for approval before anything is executed. \
Only propose a command when genuinely needed. For all other replies, respond normally as plain text.
`;

function parseResponse(text) {
  const trimmed = text.trim();
  // Strip optional ```json fences some models add
  const cleaned = trimmed.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  if (cleaned.startsWith('{')) {
    try {
      const json = JSON.parse(cleaned);
      if (json.type === 'command_proposal' && json.command) return json;
    } catch { /* fall through */ }
  }
  return { type: 'text', response: text };
}

async function queryLLM(messages) {
  const config = loadConfig();
  const activeModel = config.activeModel;
  const sysPrompt = `${COMMAND_CAPABILITY}\n\n${config.systemPrompt}`;
  const modelName = (config.models && config.models[activeModel]) || activeModel;

  const fullMessages = [
    { role: 'system', content: sysPrompt },
    ...messages,
  ];

  try {
    switch (activeModel) {
      case 'openai':    return await queryOpenAI(fullMessages, modelName);
      case 'kimi':      return await queryKimi(fullMessages, modelName);
      case 'gemini':    return await queryGemini(fullMessages, modelName);
      case 'ollama':    return await queryOllama(fullMessages, modelName);
      case 'anthropic': return await queryAnthropic(fullMessages, modelName, sysPrompt);
      case 'mistral':   return await queryMistral(fullMessages, modelName);
      case 'grok':      return await queryGrok(fullMessages, modelName);
      default:          throw new Error(`Unknown provider: ${activeModel}`);
    }
  } catch (err) {
    console.error(`LLM Error (${activeModel}/${modelName}):`, err);
    return `Error communicating with ${activeModel}: ${err.message}`;
  }
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
  const url = process.env.OLLAMA_URL || 'http://localhost:11434';
  const response = await axios.post(`${url}/api/chat`, { model, messages, stream: false });
  return response.data.message.content;
}

module.exports = { queryLLM, parseResponse };

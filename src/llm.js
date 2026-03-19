const OpenAI = require('openai');
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const { loadConfig } = require('./config');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// For Kimi (Moonshot), the OpenAI SDK can be used with a custom baseURL
const kimi = new OpenAI({
  apiKey: process.env.KIMI_API_KEY,
  baseURL: 'https://api.moonshot.cn/v1',
});
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function queryLLM(messages) {
  const config = loadConfig();
  const activeModel = config.activeModel;
  const sysPrompt = config.systemPrompt;

  const fullMessages = [
    { role: 'system', content: sysPrompt },
    ...messages
  ];

  try {
    switch (activeModel) {
      case 'openai':
        return await queryOpenAI(fullMessages);
      case 'kimi':
        return await queryKimi(fullMessages);
      case 'gemini':
        return await queryGemini(fullMessages);
      case 'ollama':
        return await queryOllama(fullMessages);
      default:
        throw new Error(`Unknown model: ${activeModel}`);
    }
  } catch (err) {
    console.error(`LLM Error (${activeModel}):`, err);
    return `Error communicating with ${activeModel}: ${err.message}`;
  }
}

async function queryOpenAI(messages) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages,
  });
  return response.choices[0].message.content;
}

async function queryKimi(messages) {
  const response = await kimi.chat.completions.create({
    model: 'moonshot-v1-8k',
    messages,
  });
  return response.choices[0].message.content;
}

async function queryGemini(messages) {
  // Gemini genai SDK handles formats slightly differently. Map 'user' and 'model'.
  // We'll use simple text generation for now until tools are fully integrated.
  const contents = messages.map(m => ({
    role: m.role === 'system' || m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));
  
  const response = await gemini.models.generateContent({
    model: 'gemini-2.5-flash',
    contents,
  });
  return response.text;
}

async function queryOllama(messages) {
  const url = process.env.OLLAMA_URL || 'http://localhost:11434';
  const response = await axios.post(`${url}/api/chat`, {
    model: 'llama3', // Make configurable later
    messages,
    stream: false,
  });
  return response.data.message.content;
}

module.exports = {
  queryLLM,
};

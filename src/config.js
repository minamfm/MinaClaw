const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.NODE_ENV === 'production' 
  ? '/app/config/config.json' 
  : path.join(__dirname, '..', 'config.json');

const defaultConfig = {
  activeModel: 'openai', // 'openai', 'gemini', 'kimi', 'ollama'
  systemPrompt: 'You are MinaClaw, a reliable 24/7 personal AI agent. Your goal is to assist the user efficiently.',
};

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      console.error('Failed to parse config.json, using defaults:', e);
      return defaultConfig;
    }
  }
  saveConfig(defaultConfig);
  return defaultConfig;
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Failed to save config.json:', e);
  }
}

function updateConfig(updates) {
  const current = loadConfig();
  const merged = { ...current, ...updates };
  saveConfig(merged);
  return merged;
}

module.exports = {
  loadConfig,
  saveConfig,
  updateConfig,
};

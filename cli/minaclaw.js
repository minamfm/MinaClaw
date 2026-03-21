#!/usr/bin/env node
'use strict';

const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execSync, exec, spawn } = require('child_process');
const yaml = require('js-yaml');

const DAEMON = 'http://localhost:6192';
const PROJECT_ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');

// If invoked as `minaclaw watch`, skip the menu and go straight to watch mode.
if (process.argv[2] === 'watch') {
  watchMode().catch(console.error);
  // watchMode() never resolves; process stays alive until Ctrl+C
  process.exitCode = 0; // suppress any exit-code noise
}

const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
const COMPOSE_FILE = path.join(PROJECT_ROOT, 'docker-compose.yml');
const ENV_PATH = path.join(CONFIG_DIR, '.env');
const CONFIG_JSON_PATH = path.join(CONFIG_DIR, 'config.json');

if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

// ─── Config helpers ───────────────────────────────────────────────────────────

function loadEnv() {
  const env = {};
  if (!fs.existsSync(ENV_PATH)) return env;
  fs.readFileSync(ENV_PATH, 'utf8').split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
  return env;
}

function saveEnv(env) {
  const content = Object.entries(env)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  fs.writeFileSync(ENV_PATH, content);
}

const DEFAULT_CONFIG = {
  activeModel: 'openai',
  systemPrompt: 'You are MinaClaw, a reliable 24/7 personal AI agent. Your goal is to assist the user efficiently.',
  models: {
    openai:    'gpt-4.1',
    gemini:    'gemini-2.5-flash',
    kimi:      'moonshot-v1-8k',
    ollama:    'llama3',
    anthropic: 'claude-sonnet-4-6',
    mistral:   'mistral-large-2411',
    grok:      'grok-4.1',
  },
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_JSON_PATH))
    return { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models } };
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...saved, models: { ...DEFAULT_CONFIG.models, ...(saved.models || {}) } };
  } catch {
    return { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models } };
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_JSON_PATH, JSON.stringify(config, null, 2));
}

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const green  = s => `\x1b[32m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;
const cyan   = s => `\x1b[36m${s}\x1b[0m`;
const dim    = s => `\x1b[2m${s}\x1b[0m`;
const bold   = s => `\x1b[1m${s}\x1b[0m`;

function apiBadge(env, envKey, model) {
  return (env[envKey] && env[envKey].trim())
    ? green(`● ${model}`)
    : yellow('○ not configured');
}

// ─── Provider model lists ─────────────────────────────────────────────────────

const OPENAI_MODELS = [
  // GPT-4.1 family (current generation)
  { name: 'gpt-4.1          (flagship, best coding & instruction)',  value: 'gpt-4.1' },
  { name: 'gpt-4.1-mini     (fast & cost-efficient)',                value: 'gpt-4.1-mini' },
  { name: 'gpt-4.1-nano     (smallest, cheapest)',                   value: 'gpt-4.1-nano' },
  new inquirer.Separator('── GPT-4o ──'),
  { name: 'gpt-4o           (multimodal, vision capable)',           value: 'gpt-4o' },
  { name: 'gpt-4o-mini      (affordable GPT-4o)',                    value: 'gpt-4o-mini' },
  new inquirer.Separator('── Reasoning (o-series) ──'),
  { name: 'o3               (frontier reasoning, math & science)',   value: 'o3' },
  { name: 'o4-mini          (fast reasoning, cost-efficient)',        value: 'o4-mini' },
  { name: 'o3-mini          (small reasoning, STEM-optimized)',      value: 'o3-mini' },
  { name: 'o3-pro           (extended compute, hardest tasks)',      value: 'o3-pro' },
  { name: 'o1               (original reasoning model)',             value: 'o1' },
];

const GEMINI_MODELS = [
  // Gemini 2.5 (stable)
  { name: 'gemini-2.5-flash  (fast, recommended, thinking capable)',  value: 'gemini-2.5-flash' },
  { name: 'gemini-2.5-pro    (most capable 2.5, 1M context)',         value: 'gemini-2.5-pro' },
  new inquirer.Separator('── Gemini 1.5 (stable) ──'),
  { name: 'gemini-1.5-flash  (stable, fast)',                         value: 'gemini-1.5-flash' },
  { name: 'gemini-1.5-pro    (stable, large context)',                value: 'gemini-1.5-pro' },
];

const CLAUDE_MODELS = [
  { name: 'claude-opus-4-6       (flagship, 1M context, extended thinking)', value: 'claude-opus-4-6' },
  { name: 'claude-sonnet-4-6     (balanced speed + intelligence)',            value: 'claude-sonnet-4-6' },
  { name: 'claude-haiku-4-5-20251001  (fast, high-volume, cost-efficient)',  value: 'claude-haiku-4-5-20251001' },
];

const MISTRAL_MODELS = [
  { name: 'mistral-large-2411    (top-tier, multilingual reasoning)',  value: 'mistral-large-2411' },
  { name: 'mistral-medium-latest (balanced cost & capability)',        value: 'mistral-medium-latest' },
  { name: 'mistral-small-latest  (fast & affordable)',                 value: 'mistral-small-latest' },
  new inquirer.Separator('── Reasoning ──'),
  { name: 'magistral-medium-latest (Mistral reasoning model)',         value: 'magistral-medium-latest' },
  { name: 'magistral-small-latest  (smaller, faster reasoning)',       value: 'magistral-small-latest' },
  new inquirer.Separator('── Code ──'),
  { name: 'codestral-latest      (code completion, always current)',   value: 'codestral-latest' },
];

const GROK_MODELS = [
  { name: 'grok-4.1              (flagship, 256k context)',            value: 'grok-4.1' },
  { name: 'grok-4.1-mini         (smaller, 128k context)',             value: 'grok-4.1-mini' },
  new inquirer.Separator('── Grok 4.1 Fast ──'),
  { name: 'grok-4.1-fast-reasoning    (2M context, reasoning)',        value: 'grok-4.1-fast-reasoning' },
  { name: 'grok-4.1-fast-non-reasoning (2M context, standard)',        value: 'grok-4.1-fast-non-reasoning' },
  new inquirer.Separator('── Grok 3 (previous gen) ──'),
  { name: 'grok-3-beta           (stable, 131k context)',              value: 'grok-3-beta' },
  { name: 'grok-3-mini-beta      (smaller, 131k context)',             value: 'grok-3-mini-beta' },
];

const KIMI_MODELS = [
  { name: 'moonshot-v1-8k    (fast, 8k context)',   value: 'moonshot-v1-8k' },
  { name: 'moonshot-v1-32k   (32k context)',         value: 'moonshot-v1-32k' },
  { name: 'moonshot-v1-128k  (128k context)',        value: 'moonshot-v1-128k' },
];

// ─── Main menu ────────────────────────────────────────────────────────────────

async function mainMenu() {
  while (true) {
    const { choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: 'MinaClaw — what would you like to do?',
      choices: [
        { name: 'Chat with Agent',              value: 'chat' },
        { name: 'Watch (run Telegram commands)', value: 'watch' },
        new inquirer.Separator('───────────────'),
        { name: 'Configure Providers & Model',  value: 'configure' },
        { name: 'Daemon Management',            value: 'daemon' },
        { name: 'Manage Safe Folders',          value: 'folders' },
        new inquirer.Separator('───────────────'),
        { name: 'Session & Memory',             value: 'session' },
        { name: 'About MinaClaw',               value: 'about' },
        new inquirer.Separator('───────────────'),
        { name: 'Exit',                         value: 'exit' },
      ],
    }]);

    switch (choice) {
      case 'chat':      await chatSession(); break;
      case 'watch':     await watchMode(); break;
      case 'configure': await configureMenu(); break;
      case 'daemon':    await daemonMenu(); break;
      case 'folders':   await manageSafeFolders(); break;
      case 'session':   await sessionMenu(); break;
      case 'about':     showAbout(); break;
      case 'exit':      process.exit(0);
    }
  }
}

// ─── Configure menu ───────────────────────────────────────────────────────────

async function configureMenu() {
  while (true) {
    const config = loadConfig();
    const env = loadEnv();

    const { choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: 'Configure — select a provider or setting:',
      choices: [
        {
          name: `Telegram Bot     ${(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN.trim()) ? green('● connected') : yellow('○ not configured')}`,
          value: 'telegram',
        },
        new inquirer.Separator(),
        {
          name: `OpenAI           ${apiBadge(env, 'OPENAI_API_KEY', config.models.openai)}`,
          value: 'openai',
        },
        {
          name: `Anthropic        ${apiBadge(env, 'ANTHROPIC_API_KEY', config.models.anthropic)}`,
          value: 'anthropic',
        },
        {
          name: `Gemini           ${apiBadge(env, 'GEMINI_API_KEY', config.models.gemini)}`,
          value: 'gemini',
        },
        {
          name: `Mistral          ${apiBadge(env, 'MISTRAL_API_KEY', config.models.mistral)}`,
          value: 'mistral',
        },
        {
          name: `xAI Grok         ${apiBadge(env, 'XAI_API_KEY', config.models.grok)}`,
          value: 'grok',
        },
        {
          name: `Kimi (Moonshot)  ${apiBadge(env, 'KIMI_API_KEY', config.models.kimi)}`,
          value: 'kimi',
        },
        {
          name: `Ollama (Local)   ${green('● ' + config.models.ollama)}  ${dim(env.OLLAMA_URL || 'http://localhost:11434')}`,
          value: 'ollama',
        },
        new inquirer.Separator(),
        {
          name: `Active Provider  ${cyan(config.activeModel)}  ${dim('(' + config.models[config.activeModel] + ')')}`,
          value: 'active',
        },
        { name: 'System Prompt',  value: 'prompt' },
        new inquirer.Separator(),
        {
          name: `Web Search       ${
            (env.BRAVE_API_KEY && env.BRAVE_API_KEY.trim())
              ? green('● Brave Search')
              : (env.GOOGLE_SEARCH_API_KEY && env.GOOGLE_SEARCH_CX)
                ? green('● Google Search')
                : yellow('○ DDG fallback (set a key for full search)')
          }`,
          value: 'websearch',
        },
        new inquirer.Separator(),
        { name: '← Back',         value: 'back' },
      ],
    }]);

    if (choice === 'back') return;
    switch (choice) {
      case 'telegram':  await configureTelegram(); break;
      case 'openai':    await configureOpenAI(); break;
      case 'anthropic': await configureAnthropic(); break;
      case 'gemini':    await configureGemini(); break;
      case 'mistral':   await configureMistral(); break;
      case 'grok':      await configureGrok(); break;
      case 'kimi':      await configureKimi(); break;
      case 'ollama':    await configureOllama(); break;
      case 'active':     await selectActiveModel(); break;
      case 'prompt':     await editSystemPrompt(); break;
      case 'websearch':  await configureWebSearch(); break;
    }
  }
}

async function configureWebSearch() {
  const env = loadEnv();

  const activeProvider =
    (env.BRAVE_API_KEY && env.BRAVE_API_KEY.trim())           ? 'Brave Search'
    : (env.GOOGLE_SEARCH_API_KEY && env.GOOGLE_SEARCH_CX)    ? 'Google Search'
    : 'DuckDuckGo (fallback)';

  while (true) {
    const { choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: `Web Search  ${dim('active: ' + activeProvider)}`,
      choices: [
        {
          name: `Brave Search     ${(env.BRAVE_API_KEY && env.BRAVE_API_KEY.trim()) ? green('● configured') : yellow('○ not set')}  ${dim('2 000 req/month free')}`,
          value: 'brave',
        },
        {
          name: `Google Search    ${(env.GOOGLE_SEARCH_API_KEY && env.GOOGLE_SEARCH_CX) ? green('● configured') : yellow('○ not set')}  ${dim('100 req/day free')}`,
          value: 'google',
        },
        new inquirer.Separator(),
        { name: '← Back', value: 'back' },
      ],
    }]);

    if (choice === 'back') return;

    if (choice === 'brave') {
      console.log(dim('\n  Get a free key at https://api.search.brave.com\n'));
      const { key } = await inquirer.prompt([{
        type: 'password',
        name: 'key',
        message: 'Brave Search API key (leave blank to keep existing):',
        mask: '*',
      }]);
      if (key) { env.BRAVE_API_KEY = key; saveEnv(env); console.log('✓ Brave Search API key saved.\n'); }
      else { console.log('No changes made.\n'); }
    }

    if (choice === 'google') {
      console.log(dim('\n  Create a Custom Search Engine at https://programmablesearchengine.google.com'));
      console.log(dim('  then enable the Custom Search API in Google Cloud Console.\n'));
      const { apiKey } = await inquirer.prompt([{
        type: 'password',
        name: 'apiKey',
        message: 'Google API key (leave blank to keep existing):',
        mask: '*',
      }]);
      const { cx } = await inquirer.prompt([{
        name: 'cx',
        message: 'Search Engine ID (cx) (leave blank to keep existing):',
        default: env.GOOGLE_SEARCH_CX || '',
      }]);
      if (apiKey) { env.GOOGLE_SEARCH_API_KEY = apiKey; }
      if (cx && cx !== (env.GOOGLE_SEARCH_CX || '')) { env.GOOGLE_SEARCH_CX = cx; }
      if (apiKey || (cx && cx !== (env.GOOGLE_SEARCH_CX || ''))) {
        saveEnv(env);
        console.log('✓ Google Search credentials saved.\n');
      } else {
        console.log('No changes made.\n');
      }
    }
  }
}

// ─── Provider screens ─────────────────────────────────────────────────────────

async function configureTelegram() {
  const env = loadEnv();
  const current = env.TELEGRAM_BOT_TOKEN;
  console.log(`\nTelegram Bot — ${current ? green('currently configured') : yellow('not configured')}`);
  if (current) console.log(`Token: ${current.slice(0, 8)}${'*'.repeat(Math.max(0, current.length - 8))}`);

  const { key } = await inquirer.prompt([{
    type: 'password',
    name: 'key',
    message: 'Bot Token (leave blank to keep existing):',
    mask: '*',
  }]);

  if (key) {
    env.TELEGRAM_BOT_TOKEN = key;
    saveEnv(env);
    console.log('✓ Telegram token saved.');
  } else {
    console.log('No changes made.');
  }
}

async function configureOpenAI() {
  const env = loadEnv();
  const config = loadConfig();
  const current = env.OPENAI_API_KEY;
  console.log(`\nOpenAI — ${current ? green('currently configured') : yellow('not configured')}`);

  const { key } = await inquirer.prompt([{
    type: 'password',
    name: 'key',
    message: 'API Key (leave blank to keep existing):',
    mask: '*',
  }]);
  if (key) { env.OPENAI_API_KEY = key; saveEnv(env); console.log('✓ API key saved.'); }

  const { model } = await inquirer.prompt([{
    type: 'list',
    name: 'model',
    message: 'Default model:',
    choices: OPENAI_MODELS,
    default: config.models.openai,
  }]);
  config.models.openai = model;
  saveConfig(config);
  console.log(`✓ OpenAI set to ${model}.`);
}

async function configureAnthropic() {
  const env = loadEnv();
  const config = loadConfig();
  const current = env.ANTHROPIC_API_KEY;
  console.log(`\nAnthropic — ${current ? green('currently configured') : yellow('not configured')}`);

  const { key } = await inquirer.prompt([{
    type: 'password',
    name: 'key',
    message: 'API Key (leave blank to keep existing):',
    mask: '*',
  }]);
  if (key) { env.ANTHROPIC_API_KEY = key; saveEnv(env); console.log('✓ API key saved.'); }

  const { model } = await inquirer.prompt([{
    type: 'list',
    name: 'model',
    message: 'Default model:',
    choices: CLAUDE_MODELS,
    default: config.models.anthropic,
  }]);
  config.models.anthropic = model;
  saveConfig(config);
  console.log(`✓ Anthropic set to ${model}.`);
}

async function configureGemini() {
  const env = loadEnv();
  const config = loadConfig();
  const current = env.GEMINI_API_KEY;
  console.log(`\nGemini — ${current ? green('currently configured') : yellow('not configured')}`);

  const { key } = await inquirer.prompt([{
    type: 'password',
    name: 'key',
    message: 'API Key (leave blank to keep existing):',
    mask: '*',
  }]);
  if (key) { env.GEMINI_API_KEY = key; saveEnv(env); console.log('✓ API key saved.'); }

  const { model } = await inquirer.prompt([{
    type: 'list',
    name: 'model',
    message: 'Default model:',
    choices: GEMINI_MODELS,
    default: config.models.gemini,
  }]);
  config.models.gemini = model;
  saveConfig(config);
  console.log(`✓ Gemini set to ${model}.`);
}

async function configureMistral() {
  const env = loadEnv();
  const config = loadConfig();
  const current = env.MISTRAL_API_KEY;
  console.log(`\nMistral — ${current ? green('currently configured') : yellow('not configured')}`);

  const { key } = await inquirer.prompt([{
    type: 'password',
    name: 'key',
    message: 'API Key (leave blank to keep existing):',
    mask: '*',
  }]);
  if (key) { env.MISTRAL_API_KEY = key; saveEnv(env); console.log('✓ API key saved.'); }

  const { model } = await inquirer.prompt([{
    type: 'list',
    name: 'model',
    message: 'Default model:',
    choices: MISTRAL_MODELS,
    default: config.models.mistral,
  }]);
  config.models.mistral = model;
  saveConfig(config);
  console.log(`✓ Mistral set to ${model}.`);
}

async function configureGrok() {
  const env = loadEnv();
  const config = loadConfig();
  const current = env.XAI_API_KEY;
  console.log(`\nxAI Grok — ${current ? green('currently configured') : yellow('not configured')}`);

  const { key } = await inquirer.prompt([{
    type: 'password',
    name: 'key',
    message: 'xAI API Key (leave blank to keep existing):',
    mask: '*',
  }]);
  if (key) { env.XAI_API_KEY = key; saveEnv(env); console.log('✓ API key saved.'); }

  const { model } = await inquirer.prompt([{
    type: 'list',
    name: 'model',
    message: 'Default model:',
    choices: GROK_MODELS,
    default: config.models.grok,
  }]);
  config.models.grok = model;
  saveConfig(config);
  console.log(`✓ Grok set to ${model}.`);
}

async function configureKimi() {
  const env = loadEnv();
  const config = loadConfig();
  const current = env.KIMI_API_KEY;
  console.log(`\nKimi (Moonshot) — ${current ? green('currently configured') : yellow('not configured')}`);

  const { key } = await inquirer.prompt([{
    type: 'password',
    name: 'key',
    message: 'API Key (leave blank to keep existing):',
    mask: '*',
  }]);
  if (key) { env.KIMI_API_KEY = key; saveEnv(env); console.log('✓ API key saved.'); }

  const { model } = await inquirer.prompt([{
    type: 'list',
    name: 'model',
    message: 'Default model:',
    choices: KIMI_MODELS,
    default: config.models.kimi,
  }]);
  config.models.kimi = model;
  saveConfig(config);
  console.log(`✓ Kimi set to ${model}.`);
}

async function configureOllama() {
  const config = loadConfig();
  const env = loadEnv();
  console.log('\nOllama (Local) — no API key required');

  // Try to discover models from the local Ollama instance
  let ollamaModels = [];
  try {
    const res = await axios.get('http://localhost:11434/api/tags', { timeout: 5000 });
    ollamaModels = (res.data.models || []);
  } catch {
    // Ollama not reachable — fall through to manual entry
  }

  let selectedModel;

  if (ollamaModels.length > 0) {
    const choices = ollamaModels.map(m => {
      const sizeGB = m.size ? (m.size / 1e9).toFixed(1) + ' GB' : '';
      const params = m.details && m.details.parameter_size ? m.details.parameter_size : '';
      const quant  = m.details && m.details.quantization_level ? m.details.quantization_level : '';
      const meta   = [params, quant, sizeGB].filter(Boolean).join(', ');
      return {
        name: `${m.name}  ${dim(meta)}`,
        value: m.name,
      };
    });
    choices.push(new inquirer.Separator());
    choices.push({ name: 'Enter model name manually...', value: '__manual__' });

    const { model } = await inquirer.prompt([{
      type: 'list',
      name: 'model',
      message: 'Select Ollama model:',
      choices,
      default: config.models.ollama,
    }]);
    selectedModel = model;
  }

  if (!ollamaModels.length || selectedModel === '__manual__') {
    if (!ollamaModels.length) {
      console.log(dim('  Could not reach Ollama at localhost:11434 — entering model name manually.\n'));
    }
    const { modelInput } = await inquirer.prompt([{
      name: 'modelInput',
      message: 'Model name (e.g. llama3, mistral, codellama):',
      default: config.models.ollama,
    }]);
    selectedModel = modelInput;
  }

  config.models.ollama = selectedModel;
  saveConfig(config);

  // Auto-save the daemon-reachable URL
  env.OLLAMA_URL = 'http://host.docker.internal:11434';
  saveEnv(env);

  console.log(`✓ Ollama set to ${selectedModel}.`);
}

async function selectActiveModel() {
  const config = loadConfig();
  const env = loadEnv();

  const label = (id, envKey) => {
    const ok = envKey === null || !!(env[envKey] && env[envKey].trim());
    return ok
      ? `${id.padEnd(8)} ${green('● ' + config.models[id])}`
      : `${id.padEnd(8)} ${yellow('○ not configured')}`;
  };

  const { model } = await inquirer.prompt([{
    type: 'list',
    name: 'model',
    message: 'Active LLM provider:',
    default: config.activeModel,
    choices: [
      { name: label('openai',    'OPENAI_API_KEY'),    value: 'openai'    },
      { name: label('anthropic', 'ANTHROPIC_API_KEY'), value: 'anthropic' },
      { name: label('gemini',    'GEMINI_API_KEY'),    value: 'gemini'    },
      { name: label('mistral',   'MISTRAL_API_KEY'),   value: 'mistral'   },
      { name: label('grok',      'XAI_API_KEY'),       value: 'grok'      },
      { name: label('kimi',      'KIMI_API_KEY'),      value: 'kimi'      },
      { name: label('ollama',    null),                value: 'ollama'    },
    ],
  }]);

  config.activeModel = model;
  saveConfig(config);
  console.log(`✓ Active provider set to ${model} (${config.models[model]}).`);
}

async function editSystemPrompt() {
  const config = loadConfig();
  const { prompt } = await inquirer.prompt([{
    type: 'editor',
    name: 'prompt',
    message: 'Edit system prompt (opens $EDITOR):',
    default: config.systemPrompt,
  }]);
  config.systemPrompt = prompt.trim();
  saveConfig(config);
  console.log('✓ System prompt updated.');
}

// ─── Host command execution ───────────────────────────────────────────────────

function executeOnHost(command) {
  return new Promise((resolve) => {
    exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
      let out = '';
      if (stdout) out += stdout;
      if (stderr) out += `STDERR:\n${stderr}`;
      if (error && !out) out += error.message;
      resolve(out.trim() || '(no output)');
    });
  });
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

// Commands the user has approved for the duration of this CLI session.
const alwaysAllowedCommands = new Set();

// Recursively handle a daemon response — supports chained command proposals.
async function handleDaemonResponse(data) {
  if (data.type === 'command_proposal') {
    console.log(`\n  ${yellow('Proposed command')}`);
    console.log(`  Reason : ${data.explanation}`);
    console.log(`  Command: ${cyan(data.command)}\n`);

    // Auto-run if user already said "always allow" for this command this session
    if (alwaysAllowedCommands.has(data.command)) {
      console.log(dim('  Auto-executing (always allowed this session)…'));
    } else {
      const { choice } = await inquirer.prompt([{
        type: 'list',
        name: 'choice',
        message: 'Execute this on your machine?',
        choices: [
          { name: 'Yes, run it',                value: 'yes'    },
          { name: 'Yes, always this session',   value: 'always' },
          { name: 'No, skip',                   value: 'no'     },
        ],
        default: 'no',
      }]);

      if (choice === 'no') { console.log(dim('  Command declined.\n')); return; }
      if (choice === 'always') alwaysAllowedCommands.add(data.command);
    }

    console.log(dim('  Running…'));
    const output = await executeOnHost(data.command);

    // Brief pause so services restarted by the command have time to come up.
    await new Promise(r => setTimeout(r, 2000));

    const followUp = await axios.post(`${DAEMON}/chat`, {
      message: `Command \`${data.command}\` finished. Output:\n\`\`\`\n${output}\n\`\`\``,
    });
    await handleDaemonResponse(followUp.data);
  } else {
    console.log(`\nMinaClaw: ${data.response || data.error || JSON.stringify(data)}\n`);
    if (data.model || data.usage) {
      const fmt   = n => (n || 0).toLocaleString();
      const model = data.model  ? data.model : '';
      const u     = data.usage  || {};
      const tokens = (u.input !== undefined)
        ? `↑ ${fmt(u.input)} in  ↓ ${fmt(u.output)} out`
        : '';
      const parts = [model, tokens].filter(Boolean);
      if (parts.length) console.log(dim(`  ${parts.join('   ')}\n`));
    }
  }
}

async function chatSession() {
  console.log('\n--- Chat Mode (type "exit" to return to menu) ---');
  while (true) {
    const { message } = await inquirer.prompt([{ name: 'message', message: '>' }]);
    if (message.toLowerCase() === 'exit') break;

    // Progress indicator — dots every 3s, escalating message after 25s
    process.stdout.write(dim('  Thinking'));
    let elapsed = 0;
    const progressInterval = setInterval(() => {
      elapsed += 3;
      process.stdout.write(dim('.'));
      if (elapsed === 27) process.stdout.write(dim(' (still working, complex task…)'));
    }, 3000);

    try {
      const res = await axios.post(`${DAEMON}/chat`, { message });
      clearInterval(progressInterval);
      process.stdout.write('\n');
      await handleDaemonResponse(res.data);
    } catch {
      clearInterval(progressInterval);
      process.stdout.write('\n');
      console.error('Cannot reach daemon on localhost:6192. Is it running? Use "Daemon Management" from the menu.');
      break;
    }
  }
}

// ─── Watch mode (Telegram command executor) ───────────────────────────────────

async function watchMode() {
  console.log('\n--- Watch Mode — polling for Telegram-approved commands (Ctrl+C to stop) ---\n');

  const poll = async () => {
    try {
      const res = await axios.get(`${DAEMON}/pending-commands`);
      const commands = res.data;

      for (const cmd of commands) {
        console.log(`\n${yellow('▶')} Executing (chat ${cmd.chatId}): ${cyan(cmd.command)}`);
        const output = await executeOnHost(cmd.command);
        console.log(`${dim('Output:')} ${output.slice(0, 300)}${output.length > 300 ? '…' : ''}`);

        await axios.post(`${DAEMON}/command-result`, {
          chatId: cmd.chatId,
          command: cmd.command,
          output,
        });
        console.log(green('✓ Result sent to Telegram.'));
      }
    } catch (err) {
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ENOTFOUND') {
        console.error(`[watcher] ${err.message}`);
      }
      // Daemon not running or transient error — will retry on next poll
    }
  };

  // Poll every 3 seconds until the process is killed
  await poll();
  const interval = setInterval(poll, 3000);

  // Keep the process alive; clean up on Ctrl+C
  await new Promise((resolve) => {
    process.once('SIGINT', () => { clearInterval(interval); resolve(); });
    process.once('SIGTERM', () => { clearInterval(interval); resolve(); });
  });

  console.log('\nWatch mode stopped.');
}

// ─── Safe Folders ─────────────────────────────────────────────────────────────

async function browseForDirectory(startPath) {
  let current = path.resolve(startPath || process.env.HOME || '/');

  while (true) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .sort((a, b) => {
          // non-hidden dirs first, then alphabetical within each group
          const aHidden = a.name.startsWith('.');
          const bHidden = b.name.startsWith('.');
          if (aHidden !== bHidden) return aHidden ? 1 : -1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      current = path.dirname(current);
      continue;
    }

    const choices = [
      { name: green('✓  Select this directory'), value: '__select__' },
      new inquirer.Separator(dim(`  ${current}`)),
    ];

    if (current !== '/') {
      choices.push({ name: dim('↑  ..'), value: '__up__' });
    }

    entries.forEach(e => {
      choices.push({
        name: e.name.startsWith('.') ? dim(e.name + '/') : (e.name + '/'),
        value: e.name,
      });
    });

    if (entries.length === 0) {
      choices.push(new inquirer.Separator(dim('  (no subdirectories)')));
    }

    choices.push(new inquirer.Separator());
    choices.push({ name: '✕  Cancel', value: '__cancel__' });

    const { selected } = await inquirer.prompt([{
      type: 'list',
      name: 'selected',
      message: 'Navigate to directory:',
      choices,
      pageSize: 18,
    }]);

    if (selected === '__select__') return current;
    if (selected === '__cancel__') return null;
    if (selected === '__up__') { current = path.dirname(current); continue; }

    const next = path.join(current, selected);
    try {
      fs.accessSync(next, fs.constants.R_OK);
      current = next;
    } catch {
      console.log(yellow(`\n  Cannot access "${selected}" — permission denied.\n`));
    }
  }
}

async function manageSafeFolders() {
  if (!fs.existsSync(COMPOSE_FILE)) {
    console.error('docker-compose.yml not found.');
    return;
  }

  while (true) {
    const doc = yaml.load(fs.readFileSync(COMPOSE_FILE, 'utf8'));
    const volumes = doc.services.minaclaw.volumes || [];
    const safeMounts = volumes.filter(v => typeof v === 'string' && v.includes('/mnt/safe'));

    const choices = [];

    if (safeMounts.length > 0) {
      safeMounts.forEach(mount => {
        const [hostPath, containerPath] = mount.split(':');
        const alias = path.basename(containerPath);
        choices.push({
          name: `${cyan(alias.padEnd(22))} ${dim(hostPath)}`,
          value: mount,
        });
      });
      choices.push(new inquirer.Separator());
    }

    choices.push({ name: '+ Add Folder', value: '__add__' });
    choices.push(new inquirer.Separator());
    choices.push({ name: '← Back',       value: '__back__' });

    const { selected } = await inquirer.prompt([{
      type: 'list',
      name: 'selected',
      message: `Safe Folders  ${cyan(safeMounts.length + ' mount(s) active')}`,
      choices,
      pageSize: 20,
    }]);

    if (selected === '__back__') return;

    if (selected === '__add__') {
      console.log('');
      const hostPath = await browseForDirectory();
      if (!hostPath) { console.log(dim('\n  Cancelled.\n')); continue; }

      if (volumes.some(v => typeof v === 'string' && v.startsWith(hostPath + ':'))) {
        console.log(yellow(`\n  "${hostPath}" is already a safe folder.\n`));
        continue;
      }

      const { alias } = await inquirer.prompt([{
        name: 'alias',
        message: 'Mount alias (name inside /mnt/safe/):',
        default: path.basename(hostPath),
      }]);

      doc.services.minaclaw.volumes = [...volumes, `${hostPath}:/mnt/safe/${alias}`];
      fs.writeFileSync(COMPOSE_FILE, yaml.dump(doc));
      console.log(green(`\n  ✓ Added "${hostPath}" as /mnt/safe/${alias}. Restart daemon to apply.\n`));
      continue;
    }

    // An existing mount was selected — show action submenu
    const [hostPath, containerPath] = selected.split(':');
    const alias = path.basename(containerPath);

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: `${cyan(alias)}  ${dim(hostPath)}`,
      choices: [
        { name: 'Rename alias', value: 'rename' },
        { name: red('Delete'),  value: 'delete' },
        new inquirer.Separator(),
        { name: '← Back',       value: 'back' },
      ],
    }]);

    if (action === 'back') continue;

    if (action === 'delete') {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Remove "${alias}" (${hostPath})?`,
        default: false,
      }]);
      if (confirm) {
        doc.services.minaclaw.volumes = volumes.filter(v => v !== selected);
        fs.writeFileSync(COMPOSE_FILE, yaml.dump(doc));
        console.log(green('\n  ✓ Removed. Restart daemon to apply.\n'));
      } else {
        console.log(dim('\n  Cancelled.\n'));
      }
    }

    if (action === 'rename') {
      const { newAlias } = await inquirer.prompt([{
        name: 'newAlias',
        message: 'New alias name:',
        default: alias,
      }]);
      const newMount = `${hostPath}:/mnt/safe/${newAlias}`;
      doc.services.minaclaw.volumes = volumes.map(v => v === selected ? newMount : v);
      fs.writeFileSync(COMPOSE_FILE, yaml.dump(doc));
      console.log(green(`\n  ✓ Renamed to "${newAlias}". Restart daemon to apply.\n`));
    }
  }
}

// ─── Watcher service ──────────────────────────────────────────────────────────

const SERVICE_NAME = 'minaclaw-watcher';
const SERVICE_PATH = path.join(process.env.HOME || '/root', `.config/systemd/user/${SERVICE_NAME}.service`);
const CLI_PATH     = path.resolve(__filename);

function getWatcherStatus() {
  try {
    const out = execSync(`systemctl --user is-active ${SERVICE_NAME} 2>/dev/null`, { encoding: 'utf8' }).trim();
    return out === 'active' ? 'running' : out;
  } catch { return 'stopped'; }
}

async function installWatcherService() {
  const nodeBin = process.execPath;
  const unit = `[Unit]
Description=MinaClaw host command watcher
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${CLI_PATH} watch
Restart=always
RestartSec=5
WorkingDirectory=${PROJECT_ROOT}

[Install]
WantedBy=default.target
`;
  const dir = path.dirname(SERVICE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SERVICE_PATH, unit);

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync(`systemctl --user enable --now ${SERVICE_NAME}`, { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.log(red('\n  Failed to enable service: ' + e.message));
    return false;
  }
}

async function uninstallWatcherService() {
  try {
    execSync(`systemctl --user disable --now ${SERVICE_NAME}`, { stdio: 'pipe' });
    if (fs.existsSync(SERVICE_PATH)) fs.unlinkSync(SERVICE_PATH);
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.log(red('\n  Failed to remove service: ' + e.message));
    return false;
  }
}

// ─── Daemon Management ───────────────────────────────────────────────────────

function runDockerCommand(description, command) {
  return new Promise((resolve) => {
    process.stdout.write(`  ${description}...`);
    exec(command, { cwd: PROJECT_ROOT, timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        console.log(` ${yellow('failed')}`);
        // Extract meaningful error lines, filtering Docker WARNING noise
        const lines = (stderr || error.message || '').split('\n')
          .filter(l => !l.startsWith('WARNING') && l.trim())
          .slice(-5);
        if (lines.length) console.log(dim('  ' + lines.join('\n  ')));
        resolve(false);
      } else {
        console.log(` ${green('done')}`);
        resolve(true);
      }
    });
  });
}

async function getDaemonStatus() {
  try {
    const output = execSync(
      'docker ps --filter name=minaclaw-daemon --format "{{.Status}}"',
      { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (output) return { running: true, status: output };
  } catch { /* ignore */ }
  return { running: false, status: '' };
}

async function daemonMenu() {
  while (true) {
    const { running, status } = await getDaemonStatus();
    const watcherStatus = getWatcherStatus();
    const daemonBadge  = running ? green(`● Running (${status})`) : yellow('○ Stopped');
    const watcherBadge = watcherStatus === 'running' ? green('● running') : yellow('○ ' + watcherStatus);

    const { choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: `Daemon Management  ${daemonBadge}`,
      choices: [
        { name: 'Start Daemon',   value: 'start' },
        { name: 'Stop Daemon',    value: 'stop' },
        { name: 'Restart Daemon', value: 'restart' },
        { name: 'Daemon Status',  value: 'status' },
        { name: 'View Logs',      value: 'logs' },
        new inquirer.Separator(),
        {
          name: `Host Watcher Service  ${watcherBadge}`,
          value: 'watcher',
        },
        new inquirer.Separator(),
        { name: '← Back',         value: 'back' },
      ],
    }]);

    if (choice === 'back') return;

    switch (choice) {
      case 'start': {
        console.log('');
        const built = await runDockerCommand('Building image', 'docker compose build --quiet');
        if (built) {
          await runDockerCommand('Starting container', 'docker compose up -d');
        }
        console.log('');
        break;
      }
      case 'stop': {
        console.log('');
        await runDockerCommand('Stopping daemon', 'docker compose down');
        console.log('');
        break;
      }
      case 'restart': {
        console.log('');
        await runDockerCommand('Stopping daemon', 'docker compose down');
        const built = await runDockerCommand('Building image', 'docker compose build --quiet');
        if (built) {
          await runDockerCommand('Starting container', 'docker compose up -d');
        }
        console.log('');
        break;
      }
      case 'status': {
        console.log('');
        const st = await getDaemonStatus();
        if (st.running) {
          console.log(`  Container: ${green('● Running')}  ${dim(st.status)}`);
          try {
            const res = await axios.get(`${DAEMON}/health`, { timeout: 3000 });
            console.log(`  Health:    ${green('● ' + res.data.status)}`);
          } catch {
            console.log(`  Health:    ${yellow('○ unreachable')}`);
          }
        } else {
          console.log(`  Container: ${yellow('○ Stopped')}`);
        }
        console.log('');
        break;
      }
      case 'logs': {
        console.log(dim('\n  Streaming logs (Ctrl+C to stop)...\n'));
        try {
          const child = spawn('docker', ['compose', 'logs', '--tail', '30', '-f'], {
            cwd: PROJECT_ROOT,
            stdio: 'inherit',
          });
          await new Promise((resolve) => {
            child.on('close', resolve);
            child.on('error', resolve);
          });
        } catch { /* user exited */ }
        console.log('');
        break;
      }
      case 'watcher': {
        const ws = getWatcherStatus();
        const installed = fs.existsSync(SERVICE_PATH);
        console.log('');
        console.log(`  Host Watcher Service — ${ws === 'running' ? green('● running') : yellow('○ ' + ws)}`);
        console.log(dim('  Executes Telegram-approved commands on your machine automatically.\n'));

        const watcherChoices = installed
          ? [
              { name: ws === 'running' ? 'Stop service'    : 'Start service',  value: 'toggle' },
              { name: 'Restart service',                                         value: 'restart' },
              { name: red('Uninstall service'),                                  value: 'uninstall' },
              new inquirer.Separator(),
              { name: '← Back',                                                  value: 'back' },
            ]
          : [
              { name: green('Install & start automatically on boot'),            value: 'install' },
              new inquirer.Separator(),
              { name: '← Back',                                                  value: 'back' },
            ];

        const { watcherAction } = await inquirer.prompt([{
          type: 'list',
          name: 'watcherAction',
          message: 'Host Watcher Service:',
          choices: watcherChoices,
        }]);

        if (watcherAction === 'install') {
          process.stdout.write('  Installing service...');
          const ok = await installWatcherService();
          console.log(ok ? ` ${green('done')}` : '');
          if (ok) console.log(green('  ✓ Watcher is now running and will start automatically on boot.\n'));
        } else if (watcherAction === 'toggle') {
          const cmd = ws === 'running' ? 'stop' : 'start';
          execSync(`systemctl --user ${cmd} ${SERVICE_NAME}`, { stdio: 'pipe' });
          console.log(green(`  ✓ Service ${cmd}ped.\n`));
        } else if (watcherAction === 'restart') {
          execSync(`systemctl --user restart ${SERVICE_NAME}`, { stdio: 'pipe' });
          console.log(green('  ✓ Service restarted.\n'));
        } else if (watcherAction === 'uninstall') {
          const { confirm } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirm',
            message: 'Uninstall the watcher service?',
            default: false,
          }]);
          if (confirm) {
            await uninstallWatcherService();
            console.log(green('  ✓ Service removed.\n'));
          }
        }
        break;
      }
    }
  }
}

// ─── Session & Memory ─────────────────────────────────────────────────────────

async function sessionMenu() {
  while (true) {
    const { choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: 'Session & Memory',
      choices: [
        { name: 'View Session Info',    value: 'info' },
        { name: 'Clear Chat Session',   value: 'clear' },
        new inquirer.Separator(),
        { name: 'View identity.md',     value: 'view_identity' },
        { name: 'View memory.md',       value: 'view_memory' },
        { name: 'Clear identity.md',    value: 'clear_identity' },
        { name: 'Clear memory.md',      value: 'clear_memory' },
        new inquirer.Separator(),
        { name: '← Back',               value: 'back' },
      ],
    }]);

    if (choice === 'back') return;

    switch (choice) {
      case 'info': {
        const config = loadConfig();
        const env = loadEnv();
        console.log('');
        console.log(`  Provider:       ${cyan(config.activeModel)}`);
        console.log(`  Model:          ${config.models[config.activeModel]}`);
        console.log(`  Prompt version: ${config.promptVersion || 'unknown'}`);
        try {
          await axios.get(`${DAEMON}/health`, { timeout: 3000 });
          console.log(`  Daemon:         ${green('● reachable')}`);
        } catch {
          console.log(`  Daemon:         ${yellow('○ unreachable')}`);
        }
        console.log('');
        break;
      }
      case 'clear': {
        try {
          await axios.post(`${DAEMON}/session/clear`, { sessionId: 'cli' });
          console.log('✓ Chat session cleared.');
        } catch {
          console.log(yellow('Could not reach daemon — is it running?'));
        }
        break;
      }
      case 'view_identity': {
        const filePath = path.join(SKILLS_DIR, 'identity.md');
        if (fs.existsSync(filePath)) {
          console.log(`\n${dim('─── identity.md ───')}`);
          console.log(fs.readFileSync(filePath, 'utf8'));
          console.log(dim('───────────────────\n'));
        } else {
          console.log(dim('  identity.md not found.\n'));
        }
        break;
      }
      case 'view_memory': {
        const filePath = path.join(SKILLS_DIR, 'memory.md');
        if (fs.existsSync(filePath)) {
          console.log(`\n${dim('─── memory.md ───')}`);
          console.log(fs.readFileSync(filePath, 'utf8'));
          console.log(dim('─────────────────\n'));
        } else {
          console.log(dim('  memory.md not found.\n'));
        }
        break;
      }
      case 'clear_identity':
      case 'clear_memory': {
        const filename = choice === 'clear_identity' ? 'identity.md' : 'memory.md';
        const filePath = path.join(SKILLS_DIR, filename);
        const { confirm } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Clear ${filename}? This cannot be undone.`,
          default: false,
        }]);
        if (confirm) {
          fs.writeFileSync(filePath, '');
          console.log(`✓ ${filename} cleared.`);
        } else {
          console.log('Cancelled.');
        }
        break;
      }
    }
  }
}

// ─── About ────────────────────────────────────────────────────────────────────

function showAbout() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const config = loadConfig();

  console.log('');
  console.log(`  ${bold('MinaClaw')} v${pkg.version}`);
  console.log(`  Your personal AI agent — always on, always ready.`);
  console.log('');
  console.log(`  Provider:       ${cyan(config.activeModel)} ${dim('(' + config.models[config.activeModel] + ')')}`);
  console.log(`  Prompt version: ${config.promptVersion || 'unknown'}`);
  console.log(`  Daemon URL:     ${dim(DAEMON)}`);
  console.log(`  Config dir:     ${dim(CONFIG_DIR)}`);
  console.log(`  Skills dir:     ${dim(SKILLS_DIR)}`);
  console.log('');
}

if (process.argv[2] !== 'watch') {
  mainMenu().catch(console.error);
}

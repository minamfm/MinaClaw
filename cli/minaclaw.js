#!/usr/bin/env node
'use strict';

const {
  intro, outro, select, text, password, confirm,
  note, spinner, isCancel, log,
} = require('@clack/prompts');
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const qrcode = require('qrcode-terminal');
const { execSync, exec, spawn } = require('child_process');
const yaml = require('js-yaml');

const DAEMON = 'http://localhost:6192';
const PROJECT_ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');

// If invoked as `minaclaw watch`, skip the menu and go straight to watch mode.
if (process.argv[2] === 'watch') {
  watchMode().catch(console.error);
  process.exitCode = 0;
}

const CONFIG_DIR      = path.join(PROJECT_ROOT, 'config');
const COMPOSE_FILE    = path.join(PROJECT_ROOT, 'docker-compose.yml');
const ENV_PATH        = path.join(CONFIG_DIR, '.env');
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
    openai:    'gpt-5.4',
    gemini:    'gemini-2.5-flash',
    kimi:      'kimi-k2.5',
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

function configured(env, key) {
  return !!(env[key] && env[key].trim());
}

// ─── Cancellation helper ──────────────────────────────────────────────────────

class UserCancel extends Error {}

function orCancel(v) {
  if (isCancel(v)) throw new UserCancel();
  return v;
}

// ─── External editor ──────────────────────────────────────────────────────────

function editWithExternalEditor(defaultContent) {
  const tmpFile = path.join('/tmp', `minaclaw-edit-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, defaultContent);
  const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
  return new Promise((resolve) => {
    const child = spawn(editor, [tmpFile], { stdio: 'inherit' });
    child.on('close', () => {
      const content = fs.existsSync(tmpFile) ? fs.readFileSync(tmpFile, 'utf8') : defaultContent;
      try { fs.unlinkSync(tmpFile); } catch {}
      resolve(content);
    });
    child.on('error', () => resolve(defaultContent));
  });
}

// ─── Provider model lists ─────────────────────────────────────────────────────

const OPENAI_MODELS = [
  { value: 'gpt-5.4',      label: 'gpt-5.4',      hint: 'flagship, latest generation' },
  { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini', hint: 'fast & cost-efficient' },
  { value: 'gpt-5.4-nano', label: 'gpt-5.4-nano', hint: 'smallest, cheapest' },
  { value: 'gpt-4.1',      label: 'gpt-4.1',      hint: 'best coding & instruction' },
  { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini', hint: 'fast & cost-efficient' },
  { value: 'gpt-4.1-nano', label: 'gpt-4.1-nano', hint: 'smallest, cheapest' },
  { value: 'gpt-4o',       label: 'gpt-4o',       hint: 'multimodal, vision capable' },
  { value: 'gpt-4o-mini',  label: 'gpt-4o-mini',  hint: 'affordable GPT-4o' },
  { value: 'o3',           label: 'o3',           hint: 'reasoning — frontier, math & science' },
  { value: 'o4-mini',      label: 'o4-mini',      hint: 'reasoning — fast, cost-efficient' },
  { value: 'o3-mini',      label: 'o3-mini',      hint: 'reasoning — STEM-optimized' },
  { value: 'o3-pro',       label: 'o3-pro',       hint: 'reasoning — extended compute, hardest tasks' },
  { value: 'o1',           label: 'o1',           hint: 'reasoning — original model' },
];

const GEMINI_MODELS = [
  { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash', hint: 'fast, recommended, thinking capable' },
  { value: 'gemini-2.5-pro',   label: 'gemini-2.5-pro',   hint: 'most capable 2.5, 1M context' },
  { value: 'gemini-1.5-flash', label: 'gemini-1.5-flash', hint: 'stable, fast' },
  { value: 'gemini-1.5-pro',   label: 'gemini-1.5-pro',   hint: 'stable, large context' },
];

const CLAUDE_MODELS = [
  { value: 'claude-opus-4-6',           label: 'claude-opus-4-6',   hint: 'flagship, 1M context, extended thinking' },
  { value: 'claude-sonnet-4-6',         label: 'claude-sonnet-4-6', hint: 'balanced speed + intelligence' },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5',  hint: 'fast, high-volume, cost-efficient' },
];

const MISTRAL_MODELS = [
  { value: 'mistral-large-2411',      label: 'mistral-large-2411',      hint: 'top-tier, multilingual reasoning' },
  { value: 'mistral-medium-latest',   label: 'mistral-medium-latest',   hint: 'balanced cost & capability' },
  { value: 'mistral-small-latest',    label: 'mistral-small-latest',    hint: 'fast & affordable' },
  { value: 'magistral-medium-latest', label: 'magistral-medium-latest', hint: 'Mistral reasoning model' },
  { value: 'magistral-small-latest',  label: 'magistral-small-latest',  hint: 'smaller, faster reasoning' },
  { value: 'codestral-latest',        label: 'codestral-latest',        hint: 'code completion' },
];

const GROK_MODELS = [
  { value: 'grok-4.1',                    label: 'grok-4.1',                    hint: 'flagship, 256k context' },
  { value: 'grok-4.1-mini',               label: 'grok-4.1-mini',               hint: 'smaller, 128k context' },
  { value: 'grok-4.1-fast-reasoning',     label: 'grok-4.1-fast-reasoning',     hint: '2M context, reasoning' },
  { value: 'grok-4.1-fast-non-reasoning', label: 'grok-4.1-fast-non-reasoning', hint: '2M context, standard' },
  { value: 'grok-3-beta',                 label: 'grok-3-beta',                 hint: 'stable, 131k context' },
];

const KIMI_MODELS = [
  { value: 'kimi-k2.5',              label: 'kimi-k2.5',              hint: 'latest — reasoning, vision, 262K context' },
  { value: 'kimi-k2-thinking',       label: 'kimi-k2-thinking',       hint: 'deep thinking, 262K context' },
  { value: 'kimi-k2-thinking-turbo', label: 'kimi-k2-thinking-turbo', hint: 'faster thinking, 262K context' },
  { value: 'moonshot-v1-128k',       label: 'moonshot-v1-128k',       hint: 'legacy, 128K context' },
  { value: 'moonshot-v1-32k',        label: 'moonshot-v1-32k',        hint: 'legacy, 32K context' },
  { value: 'moonshot-v1-8k',         label: 'moonshot-v1-8k',         hint: 'legacy, 8K context' },
];

// ─── Main menu ────────────────────────────────────────────────────────────────

async function mainMenu() {
  intro(`${bold('MinaClaw')}  Your personal AI agent — always on, always ready`);

  while (true) {
    const choice = await select({
      message: 'What would you like to do?',
      options: [
        { value: 'chat',      label: 'Chat with Agent' },
        { value: 'watch',     label: 'Watch Mode',                hint: 'execute Telegram-approved commands' },
        { value: 'configure', label: 'Configure Providers & Model' },
        { value: 'daemon',    label: 'Daemon Management' },
        { value: 'folders',   label: 'Manage Safe Folders' },
        { value: 'session',   label: 'Session & Memory' },
        { value: 'about',     label: 'About MinaClaw' },
        { value: 'exit',      label: 'Exit' },
      ],
    });

    if (isCancel(choice) || choice === 'exit') {
      outro('Goodbye.');
      process.exit(0);
    }

    try {
      switch (choice) {
        case 'chat':      await chatSession(); break;
        case 'watch':     await watchMode(); break;
        case 'configure': await configureMenu(); break;
        case 'daemon':    await daemonMenu(); break;
        case 'folders':   await manageSafeFolders(); break;
        case 'session':   await sessionMenu(); break;
        case 'about':     showAbout(); break;
      }
    } catch (e) {
      if (!(e instanceof UserCancel)) throw e;
      // User navigated back — return to main menu
    }
  }
}

// ─── Configure menu ───────────────────────────────────────────────────────────

async function configureMenu() {
  while (true) {
    const config = loadConfig();
    const env = loadEnv();

    const choice = orCancel(await select({
      message: 'Configure — select a provider or setting:',
      options: [
        {
          value: 'telegram',
          label: 'Telegram Bot',
          hint: configured(env, 'TELEGRAM_BOT_TOKEN') ? '● connected' : '○ not configured',
        },
        { value: 'whatsapp', label: 'WhatsApp' },
        {
          value: 'openai',
          label: `OpenAI  ${apiBadge(env, 'OPENAI_API_KEY', config.models.openai)}`,
          hint: 'also required for voice transcription (Whisper)',
        },
        {
          value: 'anthropic',
          label: `Anthropic  ${apiBadge(env, 'ANTHROPIC_API_KEY', config.models.anthropic)}`,
        },
        {
          value: 'gemini',
          label: `Gemini  ${apiBadge(env, 'GEMINI_API_KEY', config.models.gemini)}`,
        },
        {
          value: 'mistral',
          label: `Mistral  ${apiBadge(env, 'MISTRAL_API_KEY', config.models.mistral)}`,
        },
        {
          value: 'grok',
          label: `xAI Grok  ${apiBadge(env, 'XAI_API_KEY', config.models.grok)}`,
        },
        {
          value: 'kimi',
          label: `Kimi (Moonshot)  ${apiBadge(env, 'KIMI_API_KEY', config.models.kimi)}`,
        },
        {
          value: 'ollama',
          label: `Ollama  ${green('● ' + config.models.ollama)}`,
          hint: env.OLLAMA_URL_DISPLAY || 'http://localhost:11434',
        },
        {
          value: 'active',
          label: 'Active Provider',
          hint: `${config.activeModel}  (${config.models[config.activeModel]})`,
        },
        { value: 'prompt',    label: 'System Prompt' },
        {
          value: 'websearch',
          label: 'Web Search',
          hint: (env.BRAVE_API_KEY && env.BRAVE_API_KEY.trim())       ? '● Brave Search'
              : (env.GOOGLE_SEARCH_API_KEY && env.GOOGLE_SEARCH_CX)   ? '● Google Search'
              : 'DDG fallback',
        },
        { value: 'back', label: '← Back' },
      ],
    }));

    if (choice === 'back') return;

    try {
      switch (choice) {
        case 'telegram':  await configureTelegram(); break;
        case 'whatsapp':  await configureWhatsApp(); break;
        case 'openai':    await configureOpenAI(); break;
        case 'anthropic': await configureAnthropic(); break;
        case 'gemini':    await configureGemini(); break;
        case 'mistral':   await configureMistral(); break;
        case 'grok':      await configureGrok(); break;
        case 'kimi':      await configureKimi(); break;
        case 'ollama':    await configureOllama(); break;
        case 'active':    await selectActiveModel(); break;
        case 'prompt':    await editSystemPrompt(); break;
        case 'websearch': await configureWebSearch(); break;
      }
    } catch (e) {
      if (!(e instanceof UserCancel)) throw e;
    }
  }
}

// ─── Provider screens ─────────────────────────────────────────────────────────

async function configureTelegram() {
  const env = loadEnv();
  const current = env.TELEGRAM_BOT_TOKEN;
  note(
    current
      ? `Currently configured: ${current.slice(0, 8)}${'*'.repeat(Math.max(0, current.length - 8))}`
      : 'Not configured yet.',
    'Telegram Bot'
  );
  const key = orCancel(await password({ message: 'Bot Token (leave blank to keep existing):' }));
  if (key) { env.TELEGRAM_BOT_TOKEN = key; saveEnv(env); log.success('Telegram token saved.'); }
  else      { log.info('No changes made.'); }
}

async function configureOpenAI() {
  const env = loadEnv();
  const config = loadConfig();
  note(
    (env.OPENAI_API_KEY
      ? `Currently configured: ${env.OPENAI_API_KEY.slice(0, 8)}…`
      : 'Not configured yet.') +
    '\n\n⚠  OpenAI key is also required for voice note transcription (Whisper API, $0.006/min).\n' +
    '   Voice notes will fail silently if this key is missing or invalid.',
    'OpenAI'
  );
  const key = orCancel(await password({ message: 'API Key (leave blank to keep existing):' }));
  if (key) { env.OPENAI_API_KEY = key; saveEnv(env); log.success('API key saved.'); }

  const model = orCancel(await select({
    message: 'Default model:',
    options: OPENAI_MODELS,
    initialValue: config.models.openai,
  }));
  config.models.openai = model;
  saveConfig(config);
  log.success(`OpenAI set to ${model}.`);
}

async function configureAnthropic() {
  const env = loadEnv();
  const config = loadConfig();
  note(
    env.ANTHROPIC_API_KEY ? `Currently configured: ${env.ANTHROPIC_API_KEY.slice(0, 8)}…` : 'Not configured yet.',
    'Anthropic'
  );
  const key = orCancel(await password({ message: 'API Key (leave blank to keep existing):' }));
  if (key) { env.ANTHROPIC_API_KEY = key; saveEnv(env); log.success('API key saved.'); }

  const model = orCancel(await select({
    message: 'Default model:',
    options: CLAUDE_MODELS,
    initialValue: config.models.anthropic,
  }));
  config.models.anthropic = model;
  saveConfig(config);
  log.success(`Anthropic set to ${model}.`);
}

async function configureGemini() {
  const env = loadEnv();
  const config = loadConfig();
  note(
    env.GEMINI_API_KEY ? `Currently configured: ${env.GEMINI_API_KEY.slice(0, 8)}…` : 'Not configured yet.',
    'Gemini'
  );
  const key = orCancel(await password({ message: 'API Key (leave blank to keep existing):' }));
  if (key) { env.GEMINI_API_KEY = key; saveEnv(env); log.success('API key saved.'); }

  const model = orCancel(await select({
    message: 'Default model:',
    options: GEMINI_MODELS,
    initialValue: config.models.gemini,
  }));
  config.models.gemini = model;
  saveConfig(config);
  log.success(`Gemini set to ${model}.`);
}

async function configureMistral() {
  const env = loadEnv();
  const config = loadConfig();
  note(
    env.MISTRAL_API_KEY ? `Currently configured: ${env.MISTRAL_API_KEY.slice(0, 8)}…` : 'Not configured yet.',
    'Mistral'
  );
  const key = orCancel(await password({ message: 'API Key (leave blank to keep existing):' }));
  if (key) { env.MISTRAL_API_KEY = key; saveEnv(env); log.success('API key saved.'); }

  const model = orCancel(await select({
    message: 'Default model:',
    options: MISTRAL_MODELS,
    initialValue: config.models.mistral,
  }));
  config.models.mistral = model;
  saveConfig(config);
  log.success(`Mistral set to ${model}.`);
}

async function configureGrok() {
  const env = loadEnv();
  const config = loadConfig();
  note(
    env.XAI_API_KEY ? `Currently configured: ${env.XAI_API_KEY.slice(0, 8)}…` : 'Not configured yet.',
    'xAI Grok'
  );
  const key = orCancel(await password({ message: 'xAI API Key (leave blank to keep existing):' }));
  if (key) { env.XAI_API_KEY = key; saveEnv(env); log.success('API key saved.'); }

  const model = orCancel(await select({
    message: 'Default model:',
    options: GROK_MODELS,
    initialValue: config.models.grok,
  }));
  config.models.grok = model;
  saveConfig(config);
  log.success(`Grok set to ${model}.`);
}

async function configureKimi() {
  const env = loadEnv();
  const config = loadConfig();
  note(
    env.KIMI_API_KEY ? `Currently configured: ${env.KIMI_API_KEY.slice(0, 8)}…` : 'Not configured yet.',
    'Kimi (Moonshot AI)'
  );
  const key = orCancel(await password({ message: 'API Key (leave blank to keep existing):' }));
  if (key) { env.KIMI_API_KEY = key; saveEnv(env); log.success('API key saved.'); }

  const model = orCancel(await select({
    message: 'Default model:',
    options: KIMI_MODELS,
    initialValue: config.models.kimi,
  }));
  config.models.kimi = model;
  saveConfig(config);
  log.success(`Kimi set to ${model}.`);
}

async function configureOllama() {
  const config = loadConfig();
  const env = loadEnv();
  note('No API key required.', 'Ollama');

  const currentUrl = env.OLLAMA_URL_DISPLAY || env.OLLAMA_URL || 'http://localhost:11434';
  const ollamaUrl = orCancel(await text({
    message: 'Ollama URL (local or remote):',
    initialValue: currentUrl,
  }));

  let ollamaModels = [];
  let ollamaReachable = false;
  const s = spinner();
  s.start('Connecting to Ollama…');
  try {
    const res = await axios.get(`${ollamaUrl.replace(/\/$/, '')}/api/tags`, { timeout: 5000 });
    ollamaReachable = true;
    ollamaModels = res.data.models || [];
    s.stop(`Found ${ollamaModels.length} model(s).`);
  } catch {
    s.stop('Could not reach Ollama — will enter model name manually.');
  }

  let selectedModel;

  if (ollamaModels.length > 0) {
    const choices = ollamaModels.map(m => {
      const sizeGB = m.size ? (m.size / 1e9).toFixed(1) + ' GB' : '';
      const params = m.details?.parameter_size || '';
      const quant  = m.details?.quantization_level || '';
      const hint   = [params, quant, sizeGB].filter(Boolean).join(', ');
      return { value: m.name, label: m.name, hint };
    });
    choices.push({ value: '__manual__', label: 'Enter model name manually…' });

    selectedModel = orCancel(await select({
      message: 'Select Ollama model:',
      options: choices,
      initialValue: config.models.ollama,
    }));
  }

  if (!ollamaModels.length || selectedModel === '__manual__') {
    if (!ollamaReachable) log.warn(`Could not reach Ollama at ${ollamaUrl}`);
    else log.info('No models found — enter a name to use once pulled (e.g. ollama pull llama3).');
    selectedModel = orCancel(await text({
      message: 'Model name:',
      initialValue: config.models.ollama,
      placeholder: 'e.g. llama3, mistral, codellama',
    }));
  }

  config.models.ollama = selectedModel;
  saveConfig(config);

  const daemonUrl = ollamaUrl.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)/, '$1host.docker.internal');
  env.OLLAMA_URL_DISPLAY = ollamaUrl;
  env.OLLAMA_URL = daemonUrl;
  saveEnv(env);

  log.success(`Ollama set to ${selectedModel}.`);
}

async function configureWebSearch() {
  const env = loadEnv();

  while (true) {
    const activeProvider =
      (env.BRAVE_API_KEY && env.BRAVE_API_KEY.trim())        ? 'Brave Search'
      : (env.GOOGLE_SEARCH_API_KEY && env.GOOGLE_SEARCH_CX) ? 'Google Search'
      : 'DuckDuckGo (fallback)';

    const choice = orCancel(await select({
      message: `Web Search  ${dim('active: ' + activeProvider)}`,
      options: [
        {
          value: 'brave',
          label: `Brave Search  ${configured(env, 'BRAVE_API_KEY') ? green('● configured') : yellow('○ not set')}`,
          hint: '2,000 req/month free',
        },
        {
          value: 'google',
          label: `Google Search  ${(env.GOOGLE_SEARCH_API_KEY && env.GOOGLE_SEARCH_CX) ? green('● configured') : yellow('○ not set')}`,
          hint: '100 req/day free',
        },
        { value: 'back', label: '← Back' },
      ],
    }));

    if (choice === 'back') return;

    if (choice === 'brave') {
      const key = orCancel(await password({ message: 'Brave Search API key (leave blank to keep existing):' }));
      if (key) { env.BRAVE_API_KEY = key; saveEnv(env); log.success('Brave Search key saved.'); }
      else      { log.info('No changes made.'); }
    }

    if (choice === 'google') {
      note(
        'Create a Custom Search Engine at programmablesearchengine.google.com\nthen enable the Custom Search API in Google Cloud Console.',
        'Google Search'
      );
      const apiKey = orCancel(await password({ message: 'Google API key (leave blank to keep existing):' }));
      const cx     = orCancel(await text({
        message: 'Search Engine ID (cx):',
        initialValue: env.GOOGLE_SEARCH_CX || '',
        placeholder: 'leave blank to keep existing',
      }));
      if (apiKey) env.GOOGLE_SEARCH_API_KEY = apiKey;
      if (cx && cx !== env.GOOGLE_SEARCH_CX) env.GOOGLE_SEARCH_CX = cx;
      if (apiKey || cx) { saveEnv(env); log.success('Google Search credentials saved.'); }
      else              { log.info('No changes made.'); }
    }
  }
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

async function configureWhatsApp() {
  while (true) {
    let status = 'unknown';
    let connectedNumber = null;
    let numbers = [];

    try {
      const [statusRes, numbersRes] = await Promise.all([
        axios.get(`${DAEMON}/whatsapp/status`, { timeout: 3000 }),
        axios.get(`${DAEMON}/whatsapp/numbers`, { timeout: 3000 }),
      ]);
      status = statusRes.data.status;
      connectedNumber = statusRes.data.number;
      numbers = numbersRes.data.numbers || [];
    } catch {
      status = 'daemon_unreachable';
    }

    const statusLabel =
      status === 'connected'        ? green(`● Connected${connectedNumber ? ' (' + connectedNumber + ')' : ''}`) :
      status === 'qr'               ? yellow('○ Waiting for QR scan') :
      status === 'connecting'       ? yellow('○ Connecting…') :
      status === 'disconnected'     ? yellow('○ Disconnected') :
      status === 'daemon_unreachable' ? red('○ Daemon unreachable') :
      dim('○ ' + status);

    const choice = orCancel(await select({
      message: `WhatsApp  ${statusLabel}`,
      options: [
        { value: 'link',    label: 'Link Device (QR code)', hint: status === 'connected' ? 'already connected' : '' },
        { value: 'numbers', label: `Manage Allowed Numbers  ${dim('(' + numbers.length + ' bound)')}` },
        { value: 'back',    label: '← Back' },
      ],
    }));

    if (choice === 'back') return;
    if (choice === 'link')    await linkWhatsApp();
    if (choice === 'numbers') await manageWhatsAppNumbers(numbers);
  }
}

async function linkWhatsApp() {
  let st;
  try {
    const res = await axios.get(`${DAEMON}/whatsapp/status`, { timeout: 3000 });
    st = res.data.status;
  } catch {
    log.error('Cannot reach daemon. Is it running?');
    return;
  }

  if (st === 'connected') {
    log.info('WhatsApp is already connected.');
    return;
  }

  log.info('Open WhatsApp on your phone → Linked Devices → Link a Device');
  log.info('Press Ctrl+C to cancel.\n');

  const s = spinner();
  s.start('Waiting for QR code from daemon…');

  for (let i = 0; i < 60; i++) {
    try {
      const res = await axios.get(`${DAEMON}/whatsapp/qr`, { timeout: 3000 });
      if (res.data.qr) {
        s.stop('QR code ready — scan with WhatsApp:');
        console.log('');
        qrcode.generate(res.data.qr, { small: true });
        console.log('');
        log.info('Waiting for scan…');

        for (let j = 0; j < 30; j++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const check = await axios.get(`${DAEMON}/whatsapp/status`, { timeout: 3000 });
            if (check.data.status === 'connected') {
              log.success(`Connected as ${check.data.number || 'unknown'}.`);
              return;
            }
          } catch {}
        }
        log.warn('Timed out waiting for scan. Try again.');
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  s.stop('');
  log.warn('No QR code available. Make sure the daemon is running and try again.');
}

async function manageWhatsAppNumbers(numbers) {
  while (true) {
    const bound = numbers.map(n => ({ value: n, label: `+${n}` }));
    bound.push({ value: '__add__',  label: '+ Bind a number' });
    bound.push({ value: '__back__', label: '← Back' });

    const selected = orCancel(await select({
      message: `Allowed Numbers  ${dim('(only these numbers can message the agent)')}`,
      options: bound,
    }));

    if (selected === '__back__') return;

    if (selected === '__add__') {
      const num = orCancel(await text({
        message: 'Phone number with country code:',
        placeholder: '+201234567890',
      }));
      if (!num) continue;
      try {
        const res = await axios.post(`${DAEMON}/whatsapp/bind`, { number: num }, { timeout: 5000 });
        numbers = res.data.numbers || numbers;
        log.success(`Bound ${num}.`);
      } catch {
        log.error('Failed to bind number — is the daemon running?');
      }
      continue;
    }

    const action = orCancel(await select({
      message: `+${selected}`,
      options: [
        { value: 'unbind', label: red('Unbind this number') },
        { value: 'back',   label: '← Back' },
      ],
    }));

    if (action === 'back') continue;

    if (action === 'unbind') {
      const ok = orCancel(await confirm({ message: `Unbind +${selected}?`, initialValue: false }));
      if (ok) {
        try {
          const res = await axios.post(`${DAEMON}/whatsapp/unbind`, { number: selected }, { timeout: 5000 });
          numbers = res.data.numbers || numbers.filter(n => n !== selected);
          log.success(`Unbound +${selected}.`);
        } catch {
          log.error('Failed to unbind — is the daemon running?');
        }
      }
    }
  }
}

async function selectActiveModel() {
  const config = loadConfig();
  const env = loadEnv();

  const label = (id, envKey) => {
    const ok = envKey === null || configured(env, envKey);
    return ok ? `${id}  ${green('● ' + config.models[id])}` : `${id}  ${yellow('○ not configured')}`;
  };

  const model = orCancel(await select({
    message: 'Active LLM provider:',
    initialValue: config.activeModel,
    options: [
      { value: 'openai',    label: label('openai',    'OPENAI_API_KEY') },
      { value: 'anthropic', label: label('anthropic', 'ANTHROPIC_API_KEY') },
      { value: 'gemini',    label: label('gemini',    'GEMINI_API_KEY') },
      { value: 'mistral',   label: label('mistral',   'MISTRAL_API_KEY') },
      { value: 'grok',      label: label('grok',      'XAI_API_KEY') },
      { value: 'kimi',      label: label('kimi',      'KIMI_API_KEY') },
      { value: 'ollama',    label: label('ollama',    null) },
    ],
  }));

  config.activeModel = model;
  saveConfig(config);
  log.success(`Active provider set to ${model} (${config.models[model]}).`);
}

async function editSystemPrompt() {
  const config = loadConfig();
  note('Opening $EDITOR (or nano). Save and close to apply changes.', 'System Prompt');
  const prompt = await editWithExternalEditor(config.systemPrompt);
  config.systemPrompt = prompt.trim();
  saveConfig(config);
  log.success('System prompt updated.');
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

const alwaysAllowedCommands = new Set();

async function handleDaemonResponse(data) {
  if (data.type === 'command_proposal') {
    note(`Reason:  ${data.explanation}\nCommand: ${cyan(data.command)}`, 'Proposed Command');

    if (alwaysAllowedCommands.has(data.command)) {
      log.info('Auto-executing (always allowed this session)…');
    } else {
      const choice = orCancel(await select({
        message: 'Execute this on your machine?',
        options: [
          { value: 'yes',    label: 'Yes, run it' },
          { value: 'always', label: 'Yes, always this session' },
          { value: 'no',     label: 'No, skip' },
        ],
        initialValue: 'no',
      }));
      if (choice === 'no') { log.warn('Command declined.'); return; }
      if (choice === 'always') alwaysAllowedCommands.add(data.command);
    }

    const s = spinner();
    s.start('Running…');
    const output = await executeOnHost(data.command);
    await new Promise(r => setTimeout(r, 2000));
    s.stop('Done.');

    const followUp = await axios.post(`${DAEMON}/chat`, {
      message: `Command \`${data.command}\` finished. Output:\n\`\`\`\n${output}\n\`\`\``,
    });
    await handleDaemonResponse(followUp.data);
  } else {
    const response = data.response || data.error || JSON.stringify(data);
    note(response, 'MinaClaw');
    if (data.model || data.usage) {
      const fmt = n => (n || 0).toLocaleString();
      const u = data.usage || {};
      const parts = [data.model, u.input !== undefined ? `↑ ${fmt(u.input)}  ↓ ${fmt(u.output)}` : ''].filter(Boolean);
      if (parts.length) log.info(dim(parts.join('   ')));
    }
  }
}

async function chatSession() {
  log.info('Chat mode — type "exit" to return to menu.');
  while (true) {
    const message = orCancel(await text({ message: '>' }));
    if (!message || message.toLowerCase() === 'exit') break;

    const s = spinner();
    s.start('Thinking');
    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += 3;
      if (elapsed === 27) s.message('Thinking (complex task, still working…)');
    }, 3000);

    try {
      const res = await axios.post(`${DAEMON}/chat`, { message });
      clearInterval(interval);
      s.stop('');
      await handleDaemonResponse(res.data);
    } catch {
      clearInterval(interval);
      s.stop('');
      log.error('Cannot reach daemon on localhost:6192. Is it running? Use Daemon Management from the menu.');
      break;
    }
  }
}

// ─── Watch mode ───────────────────────────────────────────────────────────────

async function watchMode() {
  log.info('Watch Mode — polling for Telegram-approved commands (Ctrl+C to stop)');

  const poll = async () => {
    try {
      const res = await axios.get(`${DAEMON}/pending-commands`);
      for (const cmd of res.data) {
        log.info(`Executing (chat ${cmd.chatId}): ${cyan(cmd.command)}`);
        const output = await executeOnHost(cmd.command);
        log.info(`${dim('Output:')} ${output.slice(0, 300)}${output.length > 300 ? '…' : ''}`);
        await axios.post(`${DAEMON}/command-result`, { chatId: cmd.chatId, command: cmd.command, output });
        log.success('Result sent to Telegram.');
      }
    } catch (err) {
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ENOTFOUND') {
        log.error(`[watcher] ${err.message}`);
      }
    }
  };

  await poll();
  const interval = setInterval(poll, 3000);

  await new Promise((resolve) => {
    process.once('SIGINT',  () => { clearInterval(interval); resolve(); });
    process.once('SIGTERM', () => { clearInterval(interval); resolve(); });
  });

  log.info('Watch mode stopped.');
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
          const aH = a.name.startsWith('.');
          const bH = b.name.startsWith('.');
          if (aH !== bH) return aH ? 1 : -1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      current = path.dirname(current);
      continue;
    }

    const options = [
      { value: '__select__', label: green('✓  Select this directory') },
    ];
    if (current !== '/') {
      options.push({ value: '__up__', label: '↑  ..', hint: path.dirname(current) });
    }
    entries.forEach(e => {
      options.push({
        value: e.name,
        label: e.name.startsWith('.') ? dim(e.name + '/') : (e.name + '/'),
      });
    });
    if (entries.length === 0) {
      options.push({ value: '__nosubdirs__', label: dim('(no subdirectories)') });
    }
    options.push({ value: '__cancel__', label: '✕  Cancel' });

    const selected = orCancel(await select({
      message: `Navigate: ${dim(current)}`,
      options,
    }));

    if (selected === '__select__')   return current;
    if (selected === '__cancel__')   return null;
    if (selected === '__nosubdirs__') continue;
    if (selected === '__up__') { current = path.dirname(current); continue; }

    const next = path.join(current, selected);
    try {
      fs.accessSync(next, fs.constants.R_OK);
      current = next;
    } catch {
      log.warn(`Cannot access "${selected}" — permission denied.`);
    }
  }
}

async function manageSafeFolders() {
  if (!fs.existsSync(COMPOSE_FILE)) {
    log.error('docker-compose.yml not found.');
    return;
  }

  while (true) {
    const doc = yaml.load(fs.readFileSync(COMPOSE_FILE, 'utf8'));
    const volumes = doc.services.minaclaw.volumes || [];
    const safeMounts = volumes.filter(v => typeof v === 'string' && v.includes('/mnt/safe'));

    const options = safeMounts.map(mount => {
      const [hostPath, containerPath] = mount.split(':');
      const alias = path.basename(containerPath);
      return { value: mount, label: `${cyan(alias.padEnd(22))} ${dim(hostPath)}` };
    });

    options.push({ value: '__add__',  label: '+ Add Folder' });
    options.push({ value: '__back__', label: '← Back' });

    const selected = orCancel(await select({
      message: `Safe Folders  ${cyan(safeMounts.length + ' mount(s) active')}`,
      options,
    }));

    if (selected === '__back__') return;

    if (selected === '__add__') {
      const hostPath = await browseForDirectory();
      if (!hostPath) { log.info('Cancelled.'); continue; }

      if (volumes.some(v => typeof v === 'string' && v.startsWith(hostPath + ':'))) {
        log.warn(`"${hostPath}" is already a safe folder.`);
        continue;
      }

      const alias = orCancel(await text({
        message: 'Mount alias (name inside /mnt/safe/):',
        initialValue: path.basename(hostPath),
      }));

      doc.services.minaclaw.volumes = [...volumes, `${hostPath}:/mnt/safe/${alias}`];
      fs.writeFileSync(COMPOSE_FILE, yaml.dump(doc));
      log.success(`Added "${hostPath}" as /mnt/safe/${alias}. Restart daemon to apply.`);
      continue;
    }

    // Existing mount selected — show action submenu
    const [hostPath, containerPath] = selected.split(':');
    const alias = path.basename(containerPath);

    const action = orCancel(await select({
      message: `${cyan(alias)}  ${dim(hostPath)}`,
      options: [
        { value: 'rename', label: 'Rename alias' },
        { value: 'delete', label: red('Delete') },
        { value: 'back',   label: '← Back' },
      ],
    }));

    if (action === 'back') continue;

    if (action === 'delete') {
      const ok = orCancel(await confirm({
        message: `Remove "${alias}" (${hostPath})?`,
        initialValue: false,
      }));
      if (ok) {
        doc.services.minaclaw.volumes = volumes.filter(v => v !== selected);
        fs.writeFileSync(COMPOSE_FILE, yaml.dump(doc));
        log.success('Removed. Restart daemon to apply.');
      } else {
        log.info('Cancelled.');
      }
    }

    if (action === 'rename') {
      const newAlias = orCancel(await text({
        message: 'New alias name:',
        initialValue: alias,
      }));
      const newMount = `${hostPath}:/mnt/safe/${newAlias}`;
      doc.services.minaclaw.volumes = volumes.map(v => v === selected ? newMount : v);
      fs.writeFileSync(COMPOSE_FILE, yaml.dump(doc));
      log.success(`Renamed to "${newAlias}". Restart daemon to apply.`);
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
    log.error('Failed to enable service: ' + e.message);
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
    log.error('Failed to remove service: ' + e.message);
    return false;
  }
}

// ─── Daemon Management ────────────────────────────────────────────────────────

function runDockerCommand(description, command) {
  return new Promise((resolve) => {
    process.stdout.write(`  ${description}…`);
    exec(command, { cwd: PROJECT_ROOT, timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        console.log(` ${yellow('failed')}`);
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

    const choice = orCancel(await select({
      message: `Daemon Management  ${running ? green(`● Running (${status})`) : yellow('○ Stopped')}`,
      options: [
        { value: 'start',   label: 'Start Daemon' },
        { value: 'stop',    label: 'Stop Daemon' },
        { value: 'restart', label: 'Restart Daemon' },
        { value: 'status',  label: 'Status' },
        { value: 'logs',    label: 'View Logs' },
        {
          value: 'watcher',
          label: 'Host Watcher Service',
          hint: watcherStatus === 'running' ? '● running' : '○ ' + watcherStatus,
        },
        { value: 'back',    label: '← Back' },
      ],
    }));

    if (choice === 'back') return;

    switch (choice) {
      case 'start': {
        const built = await runDockerCommand('Building image', 'docker compose build --quiet');
        if (built) await runDockerCommand('Starting container', 'docker compose up -d');
        break;
      }
      case 'stop': {
        await runDockerCommand('Stopping daemon', 'docker compose down');
        break;
      }
      case 'restart': {
        await runDockerCommand('Stopping daemon', 'docker compose down');
        const built = await runDockerCommand('Building image', 'docker compose build --quiet');
        if (built) await runDockerCommand('Starting container', 'docker compose up -d');
        break;
      }
      case 'status': {
        const st = await getDaemonStatus();
        if (st.running) {
          log.info(`Container: ${green('● Running')}  ${dim(st.status)}`);
          try {
            const res = await axios.get(`${DAEMON}/health`, { timeout: 3000 });
            log.success(`Health:    ${res.data.status}`);
          } catch {
            log.warn('Health: unreachable');
          }
        } else {
          log.warn('Container: stopped');
        }
        break;
      }
      case 'logs': {
        log.info('Streaming logs (Ctrl+C to stop)…');
        try {
          const child = spawn('docker', ['compose', 'logs', '--tail', '30', '-f'], {
            cwd: PROJECT_ROOT, stdio: 'inherit',
          });
          await new Promise((resolve) => { child.on('close', resolve); child.on('error', resolve); });
        } catch { /* user exited */ }
        break;
      }
      case 'watcher': {
        await watcherMenu();
        break;
      }
    }
  }
}

async function watcherMenu() {
  const ws = getWatcherStatus();
  const installed = fs.existsSync(SERVICE_PATH);

  note(
    `Status: ${ws === 'running' ? green('● running') : yellow('○ ' + ws)}\nExecutes Telegram-approved commands on your machine automatically.`,
    'Host Watcher Service'
  );

  const options = installed
    ? [
        { value: 'toggle',    label: ws === 'running' ? 'Stop service' : 'Start service' },
        { value: 'restart',   label: 'Restart service' },
        { value: 'uninstall', label: red('Uninstall service') },
        { value: 'back',      label: '← Back' },
      ]
    : [
        { value: 'install', label: green('Install & start automatically on boot') },
        { value: 'back',    label: '← Back' },
      ];

  const action = orCancel(await select({ message: 'Host Watcher Service:', options }));

  if (action === 'back') return;

  if (action === 'install') {
    const s = spinner();
    s.start('Installing service…');
    const ok = await installWatcherService();
    s.stop(ok ? 'Installed.' : 'Installation failed.');
    if (ok) log.success('Watcher is now running and will start automatically on boot.');
  } else if (action === 'toggle') {
    const cmd = ws === 'running' ? 'stop' : 'start';
    execSync(`systemctl --user ${cmd} ${SERVICE_NAME}`, { stdio: 'pipe' });
    log.success(`Service ${cmd}ped.`);
  } else if (action === 'restart') {
    execSync(`systemctl --user restart ${SERVICE_NAME}`, { stdio: 'pipe' });
    log.success('Service restarted.');
  } else if (action === 'uninstall') {
    const ok = orCancel(await confirm({ message: 'Uninstall the watcher service?', initialValue: false }));
    if (ok) { await uninstallWatcherService(); log.success('Service removed.'); }
  }
}

// ─── Session & Memory ─────────────────────────────────────────────────────────

async function sessionMenu() {
  while (true) {
    const choice = orCancel(await select({
      message: 'Session & Memory',
      options: [
        { value: 'info',           label: 'View Session Info' },
        { value: 'clear',          label: 'Clear Chat Session' },
        { value: 'view_identity',  label: 'View identity.md' },
        { value: 'view_memory',    label: 'View memory.md' },
        { value: 'clear_identity', label: 'Clear identity.md' },
        { value: 'clear_memory',   label: 'Clear memory.md' },
        { value: 'back',           label: '← Back' },
      ],
    }));

    if (choice === 'back') return;

    switch (choice) {
      case 'info': {
        const config = loadConfig();
        const lines = [
          `Provider:       ${cyan(config.activeModel)}`,
          `Model:          ${config.models[config.activeModel]}`,
          `Prompt version: ${config.promptVersion || 'unknown'}`,
        ];
        try {
          await axios.get(`${DAEMON}/health`, { timeout: 3000 });
          lines.push(`Daemon:         ${green('● reachable')}`);
        } catch {
          lines.push(`Daemon:         ${yellow('○ unreachable')}`);
        }
        note(lines.join('\n'), 'Session Info');
        break;
      }
      case 'clear': {
        try {
          await axios.post(`${DAEMON}/session/clear`, { sessionId: 'cli' });
          log.success('Chat session cleared.');
        } catch {
          log.warn('Could not reach daemon — is it running?');
        }
        break;
      }
      case 'view_identity': {
        const filePath = path.join(SKILLS_DIR, 'identity.md');
        if (fs.existsSync(filePath)) note(fs.readFileSync(filePath, 'utf8'), 'identity.md');
        else log.info('identity.md not found.');
        break;
      }
      case 'view_memory': {
        const filePath = path.join(SKILLS_DIR, 'memory.md');
        if (fs.existsSync(filePath)) note(fs.readFileSync(filePath, 'utf8'), 'memory.md');
        else log.info('memory.md not found.');
        break;
      }
      case 'clear_identity':
      case 'clear_memory': {
        const filename = choice === 'clear_identity' ? 'identity.md' : 'memory.md';
        const filePath = path.join(SKILLS_DIR, filename);
        const ok = orCancel(await confirm({
          message: `Clear ${filename}? This cannot be undone.`,
          initialValue: false,
        }));
        if (ok) { fs.writeFileSync(filePath, ''); log.success(`${filename} cleared.`); }
        else    { log.info('Cancelled.'); }
        break;
      }
    }
  }
}

// ─── About ────────────────────────────────────────────────────────────────────

function showAbout() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const config = loadConfig();
  note(
    [
      `${bold('MinaClaw')} v${pkg.version}`,
      `Your personal AI agent — always on, always ready.`,
      '',
      `Provider:       ${cyan(config.activeModel)}  ${dim('(' + config.models[config.activeModel] + ')')}`,
      `Prompt version: ${config.promptVersion || 'unknown'}`,
      `Daemon URL:     ${dim(DAEMON)}`,
      `Config dir:     ${dim(CONFIG_DIR)}`,
      `Skills dir:     ${dim(SKILLS_DIR)}`,
    ].join('\n'),
    'About'
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (process.argv[2] !== 'watch') {
  mainMenu().catch(console.error);
}

#!/usr/bin/env node
'use strict';

const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execSync, exec } = require('child_process');
const yaml = require('js-yaml');

const DAEMON = 'http://localhost:3000';

// If invoked as `minaclaw watch`, skip the menu and go straight to watch mode.
if (process.argv[2] === 'watch') {
  watchMode().catch(console.error);
  // watchMode() never resolves; process stays alive until Ctrl+C
}

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const COMPOSE_FILE = path.join(__dirname, '..', 'docker-compose.yml');
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
const cyan   = s => `\x1b[36m${s}\x1b[0m`;
const dim    = s => `\x1b[2m${s}\x1b[0m`;

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
        { name: 'Configure Providers & Model',  value: 'configure' },
        { name: 'Manage Safe Folders',          value: 'folders' },
        { name: 'Restart Daemon',               value: 'restart' },
        new inquirer.Separator(),
        { name: 'Exit',                         value: 'exit' },
      ],
    }]);

    switch (choice) {
      case 'chat':      await chatSession(); break;
      case 'watch':     await watchMode(); break;
      case 'configure': await configureMenu(); break;
      case 'folders':   await manageSafeFolders(); break;
      case 'restart':   restartDaemon(); break;
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
      case 'active':    await selectActiveModel(); break;
      case 'prompt':    await editSystemPrompt(); break;
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
  const env = loadEnv();
  const config = loadConfig();
  const currentUrl = env.OLLAMA_URL || 'http://localhost:11434';
  console.log('\nOllama (Local) — no API key required');

  const { url } = await inquirer.prompt([{
    name: 'url',
    message: 'Ollama URL:',
    default: currentUrl,
  }]);
  if (url !== currentUrl) { env.OLLAMA_URL = url; saveEnv(env); }

  const { modelInput } = await inquirer.prompt([{
    name: 'modelInput',
    message: 'Model name (e.g. llama3, mistral, codellama):',
    default: config.models.ollama,
  }]);
  config.models.ollama = modelInput;
  saveConfig(config);
  console.log(`✓ Ollama set to ${modelInput} at ${url}.`);
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

async function chatSession() {
  console.log('\n--- Chat Mode (type "exit" to return to menu) ---');
  while (true) {
    const { message } = await inquirer.prompt([{ name: 'message', message: '>' }]);
    if (message.toLowerCase() === 'exit') break;

    try {
      const res = await axios.post(`${DAEMON}/chat`, { message });
      const data = res.data;

      if (data.type === 'command_proposal') {
        console.log(`\n  ${yellow('Proposed command')}`);
        console.log(`  Reason : ${data.explanation}`);
        console.log(`  Command: ${cyan(data.command)}\n`);

        const { confirm } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: 'Execute this on your machine?',
          default: false,
        }]);

        if (confirm) {
          console.log(dim('  Running…'));
          const output = await executeOnHost(data.command);

          // Send the raw output to the daemon — the agent formulates the reply.
          const followUp = await axios.post(`${DAEMON}/chat`, {
            message: `Command \`${data.command}\` was executed. Output:\n\`\`\`\n${output}\n\`\`\``,
          });
          const summary = followUp.data.response || followUp.data;
          console.log(`\nMinaClaw: ${summary}\n`);
        } else {
          console.log(dim('  Command declined.\n'));
        }
      } else {
        console.log(`\nMinaClaw: ${data.response}\n`);
      }
    } catch {
      console.error('Cannot reach daemon on localhost:3000. Is it running? Use "Restart Daemon" from the menu.');
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
    } catch {
      // Daemon not running — will retry silently
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

async function manageSafeFolders() {
  if (!fs.existsSync(COMPOSE_FILE)) {
    console.error('docker-compose.yml not found.');
    return;
  }
  const doc = yaml.load(fs.readFileSync(COMPOSE_FILE, 'utf8'));
  const volumes = doc.services.minaclaw.volumes || [];
  const safeMounts = volumes.filter(v => typeof v === 'string' && v.includes('/mnt/safe'));

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: `Safe Folders  ${cyan(safeMounts.length + ' mount(s) active')}`,
    choices: [
      { name: 'List Folders', value: 'list' },
      { name: 'Add Folder',   value: 'add'  },
      {
        name: safeMounts.length ? 'Remove Folder' : `Remove Folder  ${dim('(none to remove)')}`,
        value: 'remove',
      },
      new inquirer.Separator(),
      { name: '← Back', value: 'back' },
    ],
  }]);

  if (action === 'back') return;

  if (action === 'list') {
    if (!safeMounts.length) { console.log('\nNo safe folders configured.'); return; }
    console.log('\nActive mounts:');
    safeMounts.forEach(v => console.log(`  ${v}`));

  } else if (action === 'add') {
    const { hostPath } = await inquirer.prompt([{ name: 'hostPath', message: 'Host path to mount:' }]);
    const resolved = path.resolve(hostPath);
    doc.services.minaclaw.volumes = [...volumes, `${resolved}:/mnt/safe/${path.basename(resolved)}`];
    fs.writeFileSync(COMPOSE_FILE, yaml.dump(doc));
    console.log(`✓ Added. Restart daemon to apply.`);

  } else if (action === 'remove') {
    if (!safeMounts.length) { console.log('Nothing to remove.'); return; }
    const { toRemove } = await inquirer.prompt([{
      type: 'list',
      name: 'toRemove',
      message: 'Select mount to remove:',
      choices: safeMounts,
    }]);
    doc.services.minaclaw.volumes = volumes.filter(v => v !== toRemove);
    fs.writeFileSync(COMPOSE_FILE, yaml.dump(doc));
    console.log('✓ Removed. Restart daemon to apply.');
  }
}

// ─── Daemon ───────────────────────────────────────────────────────────────────

function restartDaemon() {
  const cwd = path.join(__dirname, '..');
  console.log('Stopping existing daemon (if running)...');
  try {
    execSync('docker compose down', { stdio: 'inherit', cwd });
  } catch { /* not running — that's fine */ }
  console.log('Building and starting MinaClaw daemon...');
  try {
    execSync('docker compose up -d --build', { stdio: 'inherit', cwd });
    console.log('✓ Daemon is running.');
  } catch (e) {
    console.error('Failed to start daemon:', e.message);
  }
}

mainMenu().catch(console.error);

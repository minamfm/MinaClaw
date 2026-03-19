#!/usr/bin/env node
const inquirer = require('inquirer').default;
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const COMPOSE_FILE = path.join(__dirname, '..', 'docker-compose.yml');

if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR);

async function mainMenu() {
  const { choice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'choice',
      message: 'MinaClaw CLI - Manage your daemon:',
      choices: [
        'Chat with Agent',
        'Configure API Keys & Model',
        'Manage Safe Folders',
        'Restart Daemon',
        'Exit',
      ],
    },
  ]);

  switch (choice) {
    case 'Chat with Agent': await chatSession(); break;
    case 'Configure API Keys & Model': await configureSettings(); break;
    case 'Manage Safe Folders': await manageSafeFolders(); break;
    case 'Restart Daemon': restartDaemon(); break;
    case 'Exit': process.exit(0);
  }
  await mainMenu();
}

async function chatSession() {
  console.log('\n--- Chat Mode (Type "exit" to return) ---');
  while (true) {
    const { message } = await inquirer.prompt([{ name: 'message', message: '>' }]);
    if (message.toLowerCase() === 'exit') break;

    try {
      const res = await axios.post('http://localhost:3000/chat', { message });
      console.log(`\nMinaClaw: ${res.data.response}\n`);
    } catch (err) {
      console.error('Error connecting to daemon. Is it running?');
      break;
    }
  }
}

async function configureSettings() {
  const envPath = path.join(CONFIG_DIR, '.env');
  let currentEnv = {};
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    lines.forEach(l => {
      const [k, v] = l.split('=');
      if (k) currentEnv[k.trim()] = v ? v.trim() : '';
    });
  }

  const answers = await inquirer.prompt([
    { name: 'TELEGRAM_BOT_TOKEN', message: 'Telegram Bot Token:', default: currentEnv.TELEGRAM_BOT_TOKEN },
    { name: 'OPENAI_API_KEY', message: 'OpenAI API Key:', default: currentEnv.OPENAI_API_KEY },
    { name: 'GEMINI_API_KEY', message: 'Gemini API Key:', default: currentEnv.GEMINI_API_KEY },
    { name: 'KIMI_API_KEY', message: 'KIMI (Moonshot) API Key:', default: currentEnv.KIMI_API_KEY },
  ]);

  const envContent = Object.entries(answers).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(envPath, envContent);
  console.log('Settings saved to config/.env');
}

async function manageSafeFolders() {
  let doc = yaml.load(fs.readFileSync(COMPOSE_FILE, 'utf8'));
  let volumes = doc.services.minaclaw.volumes || [];

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'Safe Folder Management:',
      choices: ['List Folders', 'Add Folder', 'Remove Folder', 'Back'],
    },
  ]);

  if (action === 'List Folders') {
    console.log('\nCurrent Safe Mounts:');
    volumes.filter(v => v.includes('/mnt/safe')).forEach(v => console.log(`- ${v}`));
  } else if (action === 'Add Folder') {
    const { hostPath } = await inquirer.prompt([{ name: 'hostPath', message: 'Host path to mount:' }]);
    const folderName = path.basename(hostPath);
    volumes.push(`${path.resolve(hostPath)}:/mnt/safe/${folderName}`);
    doc.services.minaclaw.volumes = volumes;
    fs.writeFileSync(COMPOSE_FILE, yaml.dump(doc));
    console.log('Folder added. You must restart the daemon to apply changes.');
  } else if (action === 'Remove Folder') {
    const safeMounts = volumes.filter(v => v.includes('/mnt/safe'));
    const { toRemove } = await inquirer.prompt([{ type: 'list', name: 'toRemove', choices: safeMounts, message: 'Select folder to remove:' }]);
    doc.services.minaclaw.volumes = volumes.filter(v => v !== toRemove);
    fs.writeFileSync(COMPOSE_FILE, yaml.dump(doc));
    console.log('Folder removed.');
  }
}

function restartDaemon() {
  console.log('Restarting MinaClaw daemon...');
  try {
    execSync('docker compose up -d --build', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  } catch (e) {
    console.error('Failed to restart daemon:', e.message);
  }
}

mainMenu().catch(console.error);

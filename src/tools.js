const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const SAFE_ROOT = process.env.NODE_ENV === 'production' ? '/mnt/safe' : __dirname;

function resolvePath(filePath) {
  // If in production, ensure path is within /mnt/safe
  if (process.env.NODE_ENV === 'production') {
    const resolved = path.resolve(SAFE_ROOT, filePath);
    if (!resolved.startsWith(SAFE_ROOT)) {
      throw new Error('Access denied: Path is outside of the safe directory.');
    }
    return resolved;
  }
  return path.resolve(filePath);
}

async function executeShellCommand(command) {
  return new Promise((resolve) => {
    // Basic safeguard, though in reality you'd want tighter sandboxing
    if (command.includes('rm -rf /') || command.includes('mkfs')) {
      return resolve('Command blocked due to security policies.');
    }
    
    exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
      let output = '';
      if (stdout) output += `STDOUT:\n${stdout}\n`;
      if (stderr) output += `STDERR:\n${stderr}\n`;
      if (error) output += `ERROR:\n${error.message}\n`;
      resolve(output.trim() || 'Command executed silently (no output).');
    });
  });
}

function readFile(filePath) {
  try {
    const fullPath = resolvePath(filePath);
    return fs.readFileSync(fullPath, 'utf8');
  } catch (err) {
    return `Error reading file: ${err.message}`;
  }
}

function writeFile(filePath, content) {
  try {
    const fullPath = resolvePath(filePath);
    fs.writeFileSync(fullPath, content);
    return `Successfully wrote to ${filePath}`;
  } catch (err) {
    return `Error writing file: ${err.message}`;
  }
}

module.exports = {
  executeShellCommand,
  readFile,
  writeFile,
};

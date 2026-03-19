const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');

const SAFE_ROOT = process.env.NODE_ENV === 'production' ? '/mnt/safe' : __dirname;
// Normalised with trailing separator so /mnt/safe_evil cannot pass the prefix check
const SAFE_ROOT_PREFIX = SAFE_ROOT.endsWith(path.sep) ? SAFE_ROOT : SAFE_ROOT + path.sep;

function resolvePath(filePath) {
  if (process.env.NODE_ENV === 'production') {
    const resolved = path.resolve(SAFE_ROOT, filePath);
    // Require the resolved path to be SAFE_ROOT itself or strictly inside it
    if (resolved !== SAFE_ROOT && !resolved.startsWith(SAFE_ROOT_PREFIX)) {
      throw new Error('Access denied: Path is outside of the safe directory.');
    }
    return resolved;
  }
  return path.resolve(filePath);
}

async function executeShellCommand(command) {
  return new Promise((resolve) => {
    if (command.includes('rm -rf /') || command.includes('mkfs')) {
      return resolve('Command blocked due to security policies.');
    }
    exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
      let output = '';
      if (stdout) output += `STDOUT:\n${stdout}\n`;
      if (stderr) output += `STDERR:\n${stderr}\n`;
      if (error)  output += `ERROR:\n${error.message}\n`;
      resolve(output.trim() || 'Command executed silently (no output).');
    });
  });
}

function readFile(filePath) {
  try {
    return fs.readFileSync(resolvePath(filePath), 'utf8');
  } catch (err) {
    return `Error reading file: ${err.message}`;
  }
}

function writeFile(filePath, content) {
  try {
    const fullPath = resolvePath(filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    return `Successfully wrote to ${filePath}`;
  } catch (err) {
    return `Error writing file: ${err.message}`;
  }
}

/**
 * Recursively lists all files and directories under a path inside the safe root.
 * Returns a newline-separated tree string the agent can read directly.
 * Defaults to listing the entire safe root if no path is given.
 */
function listDirectory(dirPath = '') {
  try {
    const root = resolvePath(dirPath);
    const lines = [];

    function walk(dir, prefix) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.forEach((entry, i) => {
        const isLast    = i === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const childPfx  = isLast ? prefix + '    ' : prefix + '│   ';
        lines.push(prefix + connector + entry.name + (entry.isDirectory() ? '/' : ''));
        if (entry.isDirectory()) walk(path.join(dir, entry.name), childPfx);
      });
    }

    lines.push(root);
    walk(root, '');
    return lines.join('\n');
  } catch (err) {
    return `Error listing directory: ${err.message}`;
  }
}

module.exports = {
  executeShellCommand,
  readFile,
  writeFile,
  listDirectory,
};

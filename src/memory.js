'use strict';

const fs   = require('fs');
const path = require('path');

const SKILLS_DIR = process.env.NODE_ENV === 'production'
  ? '/app/skills'
  : path.join(__dirname, '..', 'skills');

const IDENTITY_PATH = path.join(SKILLS_DIR, 'identity.md');
const MEMORY_PATH   = path.join(SKILLS_DIR, 'memory.md');

function ensureDir() {
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

function readMemoryFile(filename) {
  const p = path.join(SKILLS_DIR, filename);
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

function writeMemoryFile(filename, content) {
  ensureDir();
  fs.writeFileSync(path.join(SKILLS_DIR, filename), content.trim());
}

/**
 * Returns a formatted block ready to inject into the system prompt.
 * Returns '' when both files are empty so the prompt stays uncluttered.
 */
function loadMemoryContext() {
  const identity = readMemoryFile('identity.md');
  const memory   = readMemoryFile('memory.md');

  if (!identity && !memory) return '';

  const parts = [];
  if (identity) parts.push(`## Who You're Talking To\n${identity}`);
  if (memory)   parts.push(`## Your Notes on This User\n${memory}`);

  return parts.join('\n\n');
}

/**
 * Scans the raw LLM response for [REMEMBER: ...] and [IDENTITY: ...] tags.
 * Strips them from the text (they're for the agent's internal use, not the user).
 * Returns { cleanText, remember, identity }.
 */
function extractMemoryTags(raw) {
  let cleanText = raw;
  let remember  = null;
  let identity  = null;

  // [REMEMBER: ...] — can span multiple lines
  cleanText = cleanText.replace(/\[REMEMBER:\s*([\s\S]*?)\]/g, (_, note) => {
    remember = note.trim();
    return '';
  });

  // [IDENTITY: ...] — can span multiple lines
  cleanText = cleanText.replace(/\[IDENTITY:\s*([\s\S]*?)\]/g, (_, content) => {
    identity = content.trim();
    return '';
  });

  // Clean up any trailing blank lines left behind
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, remember, identity };
}

async function appendMemory(note) {
  ensureDir();
  const date  = new Date().toISOString().slice(0, 10);
  const entry = `\n- [${date}] ${note}`;
  fs.appendFileSync(MEMORY_PATH, entry);
}

async function replaceIdentity(content) {
  writeMemoryFile('identity.md', content);
}

module.exports = {
  loadMemoryContext,
  extractMemoryTags,
  appendMemory,
  replaceIdentity,
};

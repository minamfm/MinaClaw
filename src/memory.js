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
 * Returns '' when everything is empty so the prompt stays uncluttered.
 */
function loadMemoryContext() {
  const identity = readMemoryFile('identity.md');
  const memory   = readMemoryFile('memory.md');

  // Load all skill files (anything ending in _skill.md)
  let skills = [];
  try {
    skills = fs.readdirSync(SKILLS_DIR)
      .filter(f => f.endsWith('_skill.md'))
      .sort()
      .map(f => readMemoryFile(f))
      .filter(Boolean);
  } catch { /* skills dir missing */ }

  if (!identity && !memory && !skills.length) return '';

  const parts = [];
  if (identity)      parts.push(`## Identity & User Context\n${identity}`);
  if (memory)        parts.push(`## Your Notes\n${memory}`);
  if (skills.length) parts.push(`## Skills\n\n${skills.join('\n\n---\n\n')}`);

  return parts.join('\n\n');
}

/**
 * Scans the raw LLM response for XML-style memory tags and strips them.
 * Using XML tags avoids the bracket-format bug where a ']' inside the content
 * would prematurely close a [REMEMBER: ...] or [IDENTITY: ...] block.
 *
 *   <remember>note to append to memory.md</remember>
 *   <identity>full replacement content for identity.md</identity>
 *
 * Returns { cleanText, remember, identity }.
 */
function extractMemoryTags(raw) {
  let cleanText = raw;
  let remember  = null;
  let identity  = null;

  cleanText = cleanText.replace(/<remember>([\s\S]*?)<\/remember>/gi, (_, note) => {
    remember = note.trim();
    return '';
  });

  cleanText = cleanText.replace(/<identity>([\s\S]*?)<\/identity>/gi, (_, content) => {
    identity = content.trim();
    return '';
  });

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

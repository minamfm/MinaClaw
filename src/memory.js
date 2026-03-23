'use strict';

const fs   = require('fs');
const path = require('path');

const SKILLS_DIR   = process.env.NODE_ENV === 'production'
  ? '/app/skills'
  : path.join(__dirname, '..', 'skills');

const MEMORY_PATH   = path.join(SKILLS_DIR, 'memory.md');
const CONTACTS_DIR  = path.join(SKILLS_DIR, 'contacts');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Returns the per-contact directory for a WA session, or null for Telegram/global.
function contactDir(sessionId) {
  if (!sessionId || !sessionId.startsWith('wa:')) return null;
  const jid = sessionId.slice(3).replace(/[^\w@._-]/g, '_');
  return path.join(CONTACTS_DIR, jid);
}

function readFile(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

/**
 * Returns a formatted block ready to inject into the system prompt.
 * identity.md and memory.md are scoped per-contact for WA sessions.
 * Skills are always loaded from the shared skills/ root.
 */
function loadMemoryContext(sessionId) {
  const dir = contactDir(sessionId);

  const identity = dir
    ? readFile(path.join(dir, 'identity.md'))
    : readFile(path.join(SKILLS_DIR, 'identity.md'));

  const memory = dir
    ? readFile(path.join(dir, 'memory.md'))
    : readFile(MEMORY_PATH);

  // Skills are always global/shared
  let skills = [];
  try {
    skills = fs.readdirSync(SKILLS_DIR)
      .filter(f => f.endsWith('_skill.md'))
      .sort()
      .map(f => readFile(path.join(SKILLS_DIR, f)))
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

async function appendMemory(note, sessionId) {
  const date  = new Date().toISOString().slice(0, 10);
  const entry = `\n- [${date}] ${note}`;
  const dir   = contactDir(sessionId);
  if (dir) {
    ensureDir(dir);
    fs.appendFileSync(path.join(dir, 'memory.md'), entry);
  } else {
    ensureDir(SKILLS_DIR);
    fs.appendFileSync(MEMORY_PATH, entry);
  }
}

async function replaceIdentity(content, sessionId) {
  const dir = contactDir(sessionId);
  if (dir) {
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'identity.md'), content.trim());
  } else {
    ensureDir(SKILLS_DIR);
    fs.writeFileSync(path.join(SKILLS_DIR, 'identity.md'), content.trim());
  }
}

module.exports = {
  loadMemoryContext,
  extractMemoryTags,
  appendMemory,
  replaceIdentity,
};

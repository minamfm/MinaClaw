'use strict';

const fs   = require('fs');
const path = require('path');

// Sessions are persisted to disk so daemon restarts don't wipe conversation history.
const SESSIONS_DIR = process.env.NODE_ENV === 'production'
  ? '/app/config/sessions'
  : path.join(__dirname, '..', 'config', 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Max messages kept per session. Tool calls add 2 messages each (assistant + result),
// so this is set high enough to survive multi-step agentic conversations.
const MAX_MESSAGES = 200;

const tokenStore = new Map(); // in-memory only — token counts are ephemeral

function sessionPath(sessionId) {
  // Sanitise the session ID to make it safe as a filename
  return path.join(SESSIONS_DIR, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
}

function get(sessionId) {
  const p = sessionPath(sessionId);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function save(sessionId, history) {
  try {
    fs.writeFileSync(sessionPath(sessionId), JSON.stringify(history));
  } catch (e) {
    console.error('Session save failed:', e.message);
  }
}

function append(sessionId, role, content) {
  const history = get(sessionId);
  history.push({ role, content });
  const trimmed = history.length > MAX_MESSAGES
    ? history.slice(history.length - MAX_MESSAGES)
    : history;
  save(sessionId, trimmed);
}

function addUsage(sessionId, input = 0, output = 0) {
  const cur = tokenStore.get(sessionId) || { input: 0, output: 0 };
  tokenStore.set(sessionId, { input: cur.input + input, output: cur.output + output });
}

function getUsage(sessionId) {
  return tokenStore.get(sessionId) || { input: 0, output: 0 };
}

function clear(sessionId) {
  const p = sessionPath(sessionId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  tokenStore.delete(sessionId);
  clearThinking(sessionId);
}

// ─── Thinking (in-progress task state) ───────────────────────────────────────

function thinkingPath(sessionId) {
  return path.join(SESSIONS_DIR, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') + '_thinking.md');
}

function updateThinking(sessionId, content) {
  try { fs.writeFileSync(thinkingPath(sessionId), content); } catch (e) { console.error('Thinking write failed:', e.message); }
}

function getThinking(sessionId) {
  const p = thinkingPath(sessionId);
  if (!fs.existsSync(p)) return null;
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function clearThinking(sessionId) {
  const p = thinkingPath(sessionId);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

module.exports = { get, save, append, addUsage, getUsage, clear, updateThinking, getThinking, clearThinking };

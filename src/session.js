'use strict';

// In-memory conversation history, keyed by session ID.
// Telegram uses chatId (string); the host CLI uses 'cli'.
// Survives as long as the daemon process is alive.

const MAX_MESSAGES = 40; // 20 full back-and-forth exchanges

const store = new Map();

function get(sessionId) {
  if (!store.has(sessionId)) store.set(sessionId, []);
  return store.get(sessionId);
}

function append(sessionId, role, content) {
  const history = get(sessionId);
  history.push({ role, content });
  // Trim oldest messages when the cap is exceeded
  if (history.length > MAX_MESSAGES) {
    store.set(sessionId, history.slice(history.length - MAX_MESSAGES));
  }
}

function clear(sessionId) {
  store.delete(sessionId);
}

module.exports = { get, append, clear };

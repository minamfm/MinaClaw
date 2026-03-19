'use strict';

// In-memory queue for Telegram-approved commands awaiting host execution.
// Keyed by a monotonic ID so the CLI watcher can dequeue and post results back.

const pending = new Map();
let nextId = 1;

function enqueue(chatId, command, explanation) {
  const id = String(nextId++);
  pending.set(id, { id, chatId, command, explanation, timestamp: Date.now() });
  return id;
}

function dequeueAll() {
  const items = [...pending.values()];
  pending.clear();
  return items;
}

function cancel(id) {
  return pending.delete(id);
}

function size() {
  return pending.size;
}

module.exports = { enqueue, dequeueAll, cancel, size };

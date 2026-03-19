'use strict';

// In-memory queue for host commands awaiting execution by the CLI watcher.
// Commands start as 'pending' (awaiting user approval) and move to 'approved'
// before the watcher picks them up. Auto-approved commands skip the prompt.

const pending      = new Map(); // id → { id, chatId, command, explanation, state, timestamp }
const autoApproved = new Map(); // chatId.toString() → Set<command>
let nextId = 1;

function enqueue(chatId, command, explanation) {
  const id = String(nextId++);
  pending.set(id, { id, chatId, command, explanation, state: 'pending', timestamp: Date.now() });
  return id;
}

function getById(id) {
  return pending.get(id) || null;
}

function approve(id) {
  const item = pending.get(id);
  if (item) item.state = 'approved';
  return !!item;
}

/** Mark command as always-approved for this chatId session, and approve current pending item. */
function approveAll(chatId, command) {
  const key = String(chatId);
  if (!autoApproved.has(key)) autoApproved.set(key, new Set());
  autoApproved.get(key).add(command);
  // Approve any currently pending items with this command for this chat
  for (const item of pending.values()) {
    if (String(item.chatId) === key && item.command === command) {
      item.state = 'approved';
    }
  }
}

function isAutoApproved(chatId, command) {
  const key = String(chatId);
  return autoApproved.has(key) && autoApproved.get(key).has(command);
}

/** Returns only approved commands and removes them from the queue. */
function dequeueAll() {
  const approved = [...pending.values()].filter(item => item.state === 'approved');
  approved.forEach(item => pending.delete(item.id));
  return approved;
}

function cancel(id) {
  return pending.delete(id);
}

function size() {
  return pending.size;
}

module.exports = { enqueue, getById, approve, approveAll, isAutoApproved, dequeueAll, cancel, size };

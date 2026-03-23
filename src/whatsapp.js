const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom }      = require('@hapi/boom');
const pino          = require('pino');
const fs            = require('fs');
const axios         = require('axios');
const { queryLLMLoop }                         = require('./llm');
const { transcribeVoice }                      = require('./llm');
const { updateConfig, loadConfig }             = require('./config');
const { connectToChromeAndLearn, learnFromDirectory } = require('./browser');
const { handleScheduling }                     = require('./scheduler');
const queue   = require('./command-queue');
const session = require('./session');

const AUTH_DIR = '/app/config/whatsapp-auth';
const SILENT   = pino({ level: 'silent' });

// Resolve a @lid JID to its @s.whatsapp.net equivalent using Baileys' on-disk mapping.
// Returns the original jid unchanged if no mapping exists.
function normalizeLid(jid) {
  if (!jid || !jid.endsWith('@lid')) return jid;
  const lid = jid.slice(0, -4); // strip '@lid'
  try {
    const phone = JSON.parse(fs.readFileSync(`${AUTH_DIR}/lid-mapping-${lid}_reverse.json`, 'utf8'));
    return phone + '@s.whatsapp.net';
  } catch {
    return jid;
  }
}

// ─── Module state ─────────────────────────────────────────────────────────────

let sock            = null;
let currentQR       = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr' | 'connected'
let connectedNumber = null;
let reconnectTimer  = null;

const activeRequests = new Map();   // jid → AbortController
const pendingConsent = new Map();   // jid → {id, command}

// ─── Public API ───────────────────────────────────────────────────────────────

function getStatus() {
  return { status: connectionStatus, number: connectedNumber };
}

function getQR() {
  return currentQR;
}

async function sendToJid(jid, text) {
  if (!sock || connectionStatus !== 'connected') return;
  await sock.sendMessage(jid, { text }).catch(err =>
    console.error('[WhatsApp] Send failed:', err.message)
  );
}

// ─── Bot startup ──────────────────────────────────────────────────────────────

async function startWhatsAppBot() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  connectionStatus = 'connecting';
  currentQR        = null;

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: SILENT,
    browser: ['MinaClaw', 'Desktop', '1.0.0'],
    syncFullHistory: false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR        = qr;
      connectionStatus = 'qr';
      console.log('[WhatsApp] QR ready — waiting for scan');
    }

    if (connection === 'close') {
      currentQR        = null;
      connectedNumber  = null;

      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : undefined;

      if (code === DisconnectReason.loggedOut) {
        console.log('[WhatsApp] Logged out — clearing auth');
        connectionStatus = 'disconnected';
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      } else {
        const delay = 5000;
        console.log(`[WhatsApp] Connection closed (code ${code}) — reconnecting in ${delay / 1000}s`);
        connectionStatus = 'connecting';
        reconnectTimer = setTimeout(startWhatsAppBot, delay);
      }
    }

    if (connection === 'open') {
      currentQR        = null;
      connectionStatus = 'connected';
      connectedNumber  = sock.user?.id?.split(':')[0] || null;
      console.log(`[WhatsApp] Connected as ${connectedNumber}`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  const seenMsgIds = new Set();

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      // Deduplicate — Baileys can deliver the same message under both @lid and
      // @s.whatsapp.net JIDs; after normalizeLid both would pass the whitelist.
      const msgId = msg.key.id;
      if (msgId) {
        if (seenMsgIds.has(msgId)) continue;
        seenMsgIds.add(msgId);
        if (seenMsgIds.size > 500) seenMsgIds.delete(seenMsgIds.values().next().value);
      }
      await handleMessage(msg).catch(err =>
        console.error('[WhatsApp] handleMessage error:', err.message)
      );
    }
  });
}

// ─── Message routing ──────────────────────────────────────────────────────────

async function handleMessage(msg) {
  const jid = normalizeLid(msg.key.remoteJid);
  if (!jid) return;

  // Skip groups and broadcast
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') return;

  // Whitelist check — number without leading +, or with
  const number = jid.replace('@s.whatsapp.net', '');
  const cfg    = loadConfig();
  const allowed = (cfg.whatsappAllowedNumbers || []);
  const isAllowed = allowed.some(n => n.replace('+', '') === number || n === number || n === '+' + number);

  if (!isAllowed) {
    console.log(`[WhatsApp] Ignored message from unlisted number: ${number}`);
    return;
  }

  const content = msg.message;
  if (!content) return;

  // Extract text or transcribe voice
  let text = null;

  if (content.conversation) {
    text = content.conversation;
  } else if (content.extendedTextMessage?.text) {
    text = content.extendedTextMessage.text;
  } else if (content.audioMessage || content.pttMessage) {
    // Voice note / PTT
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: SILENT,
        reuploadRequest: sock.updateMediaMessage,
      });
      text = await transcribeVoice(buffer);
      if (!text) {
        await sendToJid(jid, '⚠️ Could not transcribe voice note. Please try again.');
        return;
      }
    } catch (err) {
      console.error('[WhatsApp] Voice transcription error:', err.message);
      await sendToJid(jid, '⚠️ Failed to process voice note. Please try again.');
      return;
    }
  }

  if (!text) return; // Unsupported message type (image, sticker, etc.)

  // ─── Built-in commands ─────────────────────────────────────────────────────

  if (text.trim() === '/kill') {
    const prev = activeRequests.get(jid);
    if (prev) {
      prev.abort();
      activeRequests.delete(jid);
    }
    const sessionId = 'wa:' + jid;
    session.clearThinking(sessionId);
    session.append(sessionId, 'assistant', '[Task cancelled by user via /kill.]');
    console.log(`[kill] jid=${jid} — killed by user`);
    await sendToJid(jid, '🛑 Stopped.');
    return;
  }

  if (text.startsWith('/bind ')) {
    const num = text.slice(6).trim();
    if (num) {
      const normalized = num.startsWith('+') ? num.slice(1) : num;
      const list = [...(cfg.whatsappAllowedNumbers || [])];
      if (!list.some(n => n.replace('+', '') === normalized)) {
        list.push(normalized);
        updateConfig({ whatsappAllowedNumbers: list });
        await sendToJid(jid, `✅ Bound ${num}.`);
      } else {
        await sendToJid(jid, `Already bound: ${num}`);
      }
    }
    return;
  }

  if (text.startsWith('/unbind ')) {
    const num = text.slice(8).trim();
    const normalized = num.startsWith('+') ? num.slice(1) : num;
    const list = (cfg.whatsappAllowedNumbers || []).filter(n => n.replace('+', '') !== normalized);
    updateConfig({ whatsappAllowedNumbers: list });
    await sendToJid(jid, `✅ Unbound ${num}.`);
    return;
  }

  if (text.startsWith('/learn ')) {
    const url = text.slice(7).trim();
    await sendToJid(jid, `Connecting to Chrome to learn from ${url}…`);
    const result = await connectToChromeAndLearn(url).catch(e => `Error: ${e.message}`);
    await sendToJid(jid, result);
    return;
  }

  if (text.startsWith('/learn_dir ')) {
    const relPath = text.slice(11).trim();
    await sendToJid(jid, `📖 Starting to read /mnt/safe/${relPath}…`);
    const onProgress = (m) => sendToJid(jid, m);
    const result = await learnFromDirectory(relPath, onProgress).catch(e => `Error: ${e.message}`);
    await sendToJid(jid, result);
    return;
  }

  if (text.startsWith('/sh ')) {
    const command = text.slice(4).trim();
    if (!command) return;
    const id = queue.enqueue(jid, command, 'Manually requested via /sh on WhatsApp');
    pendingConsent.set(jid, { id, command });
    await sendToJid(jid,
      `📋 *Command Proposal*\n\nReason: Manually requested via /sh\nCommand: ${command}\n\nReply *yes* to approve or *no* to cancel.`
    );
    return;
  }

  // ─── Pending consent check ─────────────────────────────────────────────────

  if (pendingConsent.has(jid)) {
    const { id, command } = pendingConsent.get(jid);
    const reply = text.trim().toLowerCase();
    if (reply === 'yes' || reply === 'y') {
      pendingConsent.delete(jid);
      queue.approve(id);
      await sendToJid(jid, '⏳ Approved — waiting for host CLI watcher to execute…');
      return;
    } else if (reply === 'no' || reply === 'n' || reply === 'cancel') {
      pendingConsent.delete(jid);
      queue.cancel(id);
      // Resume agent with cancellation context
      const sessionId = 'wa:' + jid;
      session.append(sessionId, 'user', `I cancelled the command proposal. Command: \`${command}\``);
      try {
        const { text: llmText, parsed, newMessages } = await queryLLMLoop(session.get(sessionId), { sessionId });
        for (const m of newMessages) session.append(sessionId, m.role, m.content);
        const r = (parsed?.type === 'text' ? parsed.response : null) || llmText;
        if (r) await sendToJid(jid, r);
      } catch {}
      return;
    } else {
      // Not a yes/no — drop the consent and process normally
      pendingConsent.delete(jid);
    }
  }

  // ─── LLM pipeline ──────────────────────────────────────────────────────────

  await processMessage(jid, text);
}

// ─── LLM pipeline ─────────────────────────────────────────────────────────────

const LIMIT_FALLBACK = 'I ran too many internal commands trying to answer that. Please ask me to continue.';

async function processMessage(jid, text) {
  // Abort any in-flight request for this JID
  const prev = activeRequests.get(jid);
  if (prev) { prev.abort(); activeRequests.delete(jid); }
  const abortController = new AbortController();
  activeRequests.set(jid, abortController);
  const { signal } = abortController;

  // Typing presence — refresh every 10s so it persists for long agent runs
  sock.sendPresenceUpdate('composing', jid).catch(() => {});
  const typingInterval = setInterval(() => sock.sendPresenceUpdate('composing', jid).catch(() => {}), 10000);

  // Record the active WhatsApp JID so notify.py can route back here
  // even if the agent forgets to pass --channel.
  try { fs.writeFileSync('/tmp/last_wa_jid', jid); } catch {}

  const sessionId = 'wa:' + jid;

  // Reminder scheduling — handle before LLM so the reminder fires back to WhatsApp
  if (text.toLowerCase().includes('remind me')) {
    const scheduled = await handleScheduling(text, msg => sendToJid(jid, msg), 'wa:' + jid);
    if (scheduled) return;
  }

  // Resumption check
  const history  = session.get(sessionId);
  const lastAsst = [...history].reverse().find(m => m.role === 'assistant');
  const resuming = lastAsst?.content === LIMIT_FALLBACK;
  const thinking = session.getThinking(sessionId);

  session.append(sessionId, 'user', text);
  let messages = session.get(sessionId);

  if (resuming || thinking) {
    const hint = thinking
      ? `\n\n[Previous progress:\n${thinking}\n\nResume from where you left off until fully complete.]`
      : '\n\n[You previously hit the tool call limit. Review the conversation history above and resume until fully complete.]';
    messages = [...messages.slice(0, -1), { role: 'user', content: `${text}${hint}` }];
    if (thinking && !resuming) session.clearThinking(sessionId);
  }

  try {
    const { text: llmText, usage, parsed, newMessages, aborted } = await queryLLMLoop(messages, { signal, sessionId });
    clearInterval(typingInterval);
    activeRequests.delete(jid);
    sock.sendPresenceUpdate('paused', jid).catch(() => {});

    if (aborted) return;

    for (const m of newMessages) session.append(sessionId, m.role, m.content);
    if (usage) session.addUsage(sessionId, usage.input, usage.output);

    if (parsed.type === 'send_telegram') {
      // Agent wants to send a Telegram message — send to WA as confirmation
      await sendToJid(jid, `📨 Sent to Telegram: ${parsed.message}`);
      return;
    }

    if (parsed.type === 'command_proposal') {
      const id = queue.enqueue(jid, parsed.command, parsed.explanation);
      pendingConsent.set(jid, { id, command: parsed.command });
      await sendToJid(jid,
        `📋 *Command Proposal*\n\nReason: ${parsed.explanation}\nCommand: ${parsed.command}\n\nReply *yes* to approve or *no* to cancel.`
      );
      return;
    }

    const finalText = (parsed.response || llmText || '').trim();
    if (finalText) await sendToJid(jid, finalText);

  } catch (err) {
    clearInterval(typingInterval);
    activeRequests.delete(jid);
    sock.sendPresenceUpdate('paused', jid).catch(() => {});
    if (signal.aborted) return;
    console.error('[WhatsApp] processMessage error:', err.message);
    await sendToJid(jid, 'Sorry, something went wrong. Please try again.');
  }
}

module.exports = { startWhatsAppBot, getStatus, getQR, sendToJid };

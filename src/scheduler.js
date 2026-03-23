const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { queryLLM } = require('./llm');

const JOBS_PATH = process.env.NODE_ENV === 'production'
  ? '/app/config/scheduled-jobs.json'
  : path.join(__dirname, '..', 'config', 'scheduled-jobs.json');

// In-memory map: id → { ...persisted fields, timer (setTimeout | cron task) }
const jobs = new Map();

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadPersistedJobs() {
  try {
    if (fs.existsSync(JOBS_PATH)) {
      return JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[scheduler] Failed to load jobs:', err.message);
  }
  return {};
}

function saveJobs() {
  const out = {};
  for (const [id, job] of jobs) {
    const { timer, ...rest } = job;
    out[id] = rest;
  }
  try {
    fs.mkdirSync(path.dirname(JOBS_PATH), { recursive: true });
    fs.writeFileSync(JOBS_PATH, JSON.stringify(out, null, 2));
  } catch (err) {
    console.error('[scheduler] Failed to save jobs:', err.message);
  }
}

// ─── Execution ────────────────────────────────────────────────────────────────

function runJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  console.log(`[scheduler] Running job ${id}: ${job.command.slice(0, 100)}`);
  exec(job.command, { timeout: 30_000 }, (err, stdout, stderr) => {
    if (err) console.error(`[scheduler] Job ${id} error:`, err.message);
    else     console.log(`[scheduler] Job ${id} done`);
  });
  // Remove one-time jobs after execution
  if (!job.cronExpr) {
    jobs.delete(id);
    saveJobs();
  }
}

// ─── Internal scheduling helpers ──────────────────────────────────────────────

function _scheduleOne(id, delayMs) {
  const timer = setTimeout(() => runJob(id), Math.max(0, delayMs));
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, timer });
}

function _scheduleCron(id, cronExpr) {
  const task = cron.schedule(cronExpr, () => runJob(id));
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, timer: task });
}

// ─── Public API ───────────────────────────────────────────────────────────────

function addOneTimeJob({ delayMs, command, label = '' }) {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const scheduledAt = Date.now();
  const runAt = scheduledAt + delayMs;
  jobs.set(id, { id, scheduledAt, runAt, command, label });
  saveJobs();
  _scheduleOne(id, delayMs);
  console.log(`[scheduler] Added job ${id} — runs in ${Math.round(delayMs / 1000)}s`);
  return id;
}

function addCronJob({ cronExpr, command, label = '' }) {
  const id = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  jobs.set(id, { id, scheduledAt: Date.now(), cronExpr, command, label });
  saveJobs();
  _scheduleCron(id, cronExpr);
  console.log(`[scheduler] Added cron job ${id} — ${cronExpr}`);
  return id;
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.timer) {
    if (job.cronExpr) job.timer.stop();
    else clearTimeout(job.timer);
  }
  jobs.delete(id);
  saveJobs();
  return true;
}

function listJobs() {
  const now = Date.now();
  return [...jobs.values()].map(({ timer, ...job }) => ({
    ...job,
    secondsRemaining: job.runAt != null
      ? Math.max(0, Math.round((job.runAt - now) / 1000))
      : null,
  }));
}

// ─── Startup restore ──────────────────────────────────────────────────────────

function restoreJobs() {
  const persisted = loadPersistedJobs();
  const now = Date.now();
  let count = 0;

  for (const [id, job] of Object.entries(persisted)) {
    jobs.set(id, job); // store first, then attach timer
    if (job.cronExpr) {
      _scheduleCron(id, job.cronExpr);
      count++;
    } else if (job.runAt != null) {
      const remaining = job.runAt - now;
      if (remaining <= -60_000) {
        // Overdue by more than 1 min — missed while container was down, run now
        console.log(`[scheduler] Overdue job ${id} (due ${new Date(job.runAt).toISOString()}) — running now`);
        setTimeout(() => runJob(id), 500);
      } else {
        _scheduleOne(id, Math.max(0, remaining));
      }
      count++;
    }
  }

  if (count > 0) console.log(`[scheduler] Restored ${count} job(s) from disk`);
}

// ─── Natural-language "remind me" handler ─────────────────────────────────────

// channel: 'telegram' | 'wa:JID'
async function handleScheduling(text, send, channel = 'telegram') {
  const extractionPrompt = `
Extract the scheduling intent from the following text.
Respond ONLY with a JSON object in this exact format:
{
  "is_reminder": true/false,
  "type": "once" or "recurring",
  "delay_seconds": number (seconds from now — required when type is "once"),
  "cron_expression": "string (5-part cron — required when type is 'recurring')",
  "message_to_send": "string — what to remind the user about"
}
If it is not a reminder or cannot be parsed, set is_reminder to false.
Text: "${text}"
  `;

  try {
    const response = await queryLLM([{ role: 'user', content: extractionPrompt }]);
    const parsed = JSON.parse(
      response.text.replace(/```json/g, '').replace(/```/g, '').trim()
    );

    if (!parsed.is_reminder) return false;

    const channelArg = channel !== 'telegram' ? ` --channel "${channel}"` : '';
    const safeMsg    = (parsed.message_to_send || '').replace(/"/g, '\\"');
    const notifyCmd  = `python3 /app/skills/notify.py "⏰ Reminder: ${safeMsg}"${channelArg}`;

    if (parsed.type === 'recurring' && parsed.cron_expression) {
      addCronJob({ cronExpr: parsed.cron_expression, command: notifyCmd, label: parsed.message_to_send });
    } else if (parsed.delay_seconds) {
      addOneTimeJob({ delayMs: parsed.delay_seconds * 1000, command: notifyCmd, label: parsed.message_to_send });
    } else {
      return false;
    }

    send(`Got it! I've scheduled a reminder: "${parsed.message_to_send}"`);
    return true;
  } catch (err) {
    console.error('[scheduler] handleScheduling failed:', err.message);
  }
  return false;
}

module.exports = {
  handleScheduling,
  addOneTimeJob,
  addCronJob,
  cancelJob,
  listJobs,
  restoreJobs,
};

/**
 * Task API routes — list, read, update (whitelist of fields), manage `extras`.
 *
 * Backed by the in-memory TaskStore (../task-store.js). All mutations flow
 * through TaskStore.update / TaskStore.addExtra / TaskStore.removeExtra so
 * the write whitelist, atomic-write, per-file serialization and git-commit
 * guarantees are uniform.
 */

const express = require('express');

const router = express.Router();
const jsonBody = express.json({ limit: '256kb' });

let _taskStore = null;

function setup({ taskStore }) {
  _taskStore = taskStore;
}

function requireStore(res) {
  if (!_taskStore) {
    res.status(503).json({ error: 'task store not initialized' });
    return false;
  }
  return true;
}

// Strip internal fields (path / body cached in memory) from outgoing payloads.
// The body is large and rarely needed by the UI; expose it via a dedicated
// endpoint if a future feature wants it.
function sanitize(task) {
  if (!task) return null;
  const out = {};
  for (const [k, v] of Object.entries(task)) {
    if (k === '_body') continue;
    out[k] = v;
  }
  return out;
}

// ── GET /api/tasks ─────────────────────────────────────────────
router.get('/api/tasks', (req, res) => {
  if (!requireStore(res)) return;
  const tasks = _taskStore.list().map(sanitize);
  res.json({ tasks });
});

// ── GET /api/tasks/:id ─────────────────────────────────────────
router.get('/api/tasks/:id', (req, res) => {
  if (!requireStore(res)) return;
  const t = _taskStore.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  res.json(sanitize(t));
});

// ── PATCH /api/tasks/:id ───────────────────────────────────────
// Body: { status?, priority?, sessions?, has_workspace?, archived_at? }
router.patch('/api/tasks/:id', jsonBody, async (req, res) => {
  if (!requireStore(res)) return;
  const body = req.body || {};
  // Reject `extras` via PATCH — it must go through the dedicated endpoint
  // so the caller can't accidentally overwrite the whole list.
  if ('extras' in body) {
    return res.status(400).json({
      error: 'Use POST /api/tasks/:id/extras or DELETE /api/tasks/:id/extras/:sessionKey to manage extras',
    });
  }
  try {
    const result = await _taskStore.update(req.params.id, body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// ── POST /api/tasks/:id/extras ─────────────────────────────────
// Body: { sessionKey: "claude:UUID" }
router.post('/api/tasks/:id/extras', jsonBody, async (req, res) => {
  if (!requireStore(res)) return;
  const sessionKey = req.body && req.body.sessionKey;
  if (typeof sessionKey !== 'string' || !sessionKey) {
    return res.status(400).json({ error: 'sessionKey (string) required' });
  }
  try {
    const result = await _taskStore.addExtra(req.params.id, sessionKey);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// ── DELETE /api/tasks/:id/extras/:sessionKey ───────────────────
// :sessionKey is URL-encoded (the `:` and `/` will be percent-escaped)
router.delete('/api/tasks/:id/extras/:sessionKey', async (req, res) => {
  if (!requireStore(res)) return;
  try {
    const sessionKey = decodeURIComponent(req.params.sessionKey);
    const result = await _taskStore.removeExtra(req.params.id, sessionKey);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// ── POST /api/tasks/:id/touch ──────────────────────────────────
// Manual "Mark touched now" affordance. Sets last_touched_at to the
// server's current time and commits as webui-auto. Use sparingly: the
// canonical path per TASK-SYSTEM-DESIGN § 2.11 is for agents to bump
// last_touched_at inside their own [T-XXX]-tagged commit. This endpoint
// is the fallback for off-agent work (Walter sent an email externally,
// made a phone call, finished a sub-step manually, etc).
router.post('/api/tasks/:id/touch', async (req, res) => {
  if (!requireStore(res)) return;
  try {
    // Match the ISO-with-offset format used elsewhere in the task system.
    // Date.toISOString gives UTC; we tolerate both forms (the rule says
    // shell-fetch local time, but for an automated webUI bump UTC is
    // unambiguous and easier to compare).
    const now = new Date().toISOString();
    const result = await _taskStore.update(req.params.id, { last_touched_at: now });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

module.exports = { router, setup };

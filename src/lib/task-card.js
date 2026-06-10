/**
 * Task card — single row in the sidebar Tasks tab. Compact, status-aware.
 *
 * Layout (single row, ~28px):
 *   [pin][priority dot] {title or task id}  {status-badge}
 *
 * Phase 2 scope:
 *   - Render
 *   - Click pin → toggle Focus
 *   - Click card → emit a 'task-selected' event (workspace switching is Phase 3)
 *   - Right-click → context menu (Pin/Unpin, Open task file in editor) — minimal
 *
 * Out of scope for Phase 2:
 *   - Real-time status indicator dot (streaming/waiting) — Phase 4
 *   - Drag to Focus — defer to polish
 */

import { escHtml, showContextMenu, copyText } from './utils.js';

const PRIORITY_COLOR = {
  urgent: '#e74c3c',
  high:   '#f39c12',
  normal: '#bdc3c7',
  low:    '#7f8c8d',
};

const STATUS_LABEL = {
  open:        'OPEN',
  in_progress: 'WIP',
  blocked:     'BLOCKED',
  done:        'DONE',
  proposed:    'PROPOSED',
  abandoned:   'X',
};

const STATUS_CLASS = {
  open:        'badge-task-open',
  in_progress: 'badge-task-wip',
  blocked:     'badge-task-blocked',
  done:        'badge-task-done',
  proposed:    'badge-task-proposed',
  abandoned:   'badge-task-abandoned',
};

/**
 * @param {object} task
 * @param {object} ctx
 * @param {boolean} ctx.pinned
 * @param {boolean} ctx.selected
 * @param {boolean} ctx.subTask  if rendered nested under a parent (visual indent)
 * @param {function(string): void} ctx.onTogglePin
 * @param {function(string): void} ctx.onSelect
 * @param {function(string): void} [ctx.onOpenFile]
 */
export function renderTaskCard(task, ctx) {
  const card = document.createElement('div');
  card.className = 'task-item-card'
    + (ctx.pinned ? ' pinned' : '')
    + (ctx.selected ? ' selected' : '')
    + (ctx.active ? ' active-task' : '')
    + (ctx.expanded ? ' expanded' : '')
    + (ctx.subTask ? ' subtask' : '');
  card.dataset.taskId = task.id;
  card.title = task.id + (task.title ? ` — ${task.title}` : '');

  // The visible top row. Detail panel (associated sessions) gets appended
  // below it when expanded, so the card is a vertical container.
  const row = document.createElement('div');
  row.className = 'task-card-row';

  // Pin toggle (left-most)
  const pinBtn = document.createElement('button');
  pinBtn.className = 'task-pin-btn' + (ctx.pinned ? ' active' : '');
  pinBtn.innerHTML = ctx.pinned ? '★' : '☆'; // ★ vs ☆
  pinBtn.title = ctx.pinned ? 'Unpin from Focus' : 'Pin to Focus';
  pinBtn.onclick = (e) => {
    e.stopPropagation();
    if (typeof ctx.onTogglePin === 'function') ctx.onTogglePin(task.id);
  };
  row.appendChild(pinBtn);

  // Priority dot
  const dot = document.createElement('span');
  dot.className = 'task-priority-dot';
  dot.style.background = PRIORITY_COLOR[task.priority] || PRIORITY_COLOR.normal;
  dot.title = `priority: ${task.priority || 'normal'}`;
  row.appendChild(dot);

  // Two-line text column: line 1 = task id (编号), line 2 = title.
  const textCol = document.createElement('div');
  textCol.className = 'task-card-text';

  const idLine = document.createElement('span');
  idLine.className = 'task-card-id';
  idLine.textContent = task.id;
  idLine.title = 'Click to copy task id';
  idLine.onclick = (e) => {
    e.stopPropagation();
    copyText(task.id);
    const prev = idLine.textContent;
    idLine.textContent = '✓ copied';
    idLine.classList.add('copied');
    setTimeout(() => { idLine.textContent = prev; idLine.classList.remove('copied'); }, 900);
  };
  textCol.appendChild(idLine);

  const title = document.createElement('span');
  title.className = 'task-card-title';
  title.textContent = task.title || task.id;
  textCol.appendChild(title);

  row.appendChild(textCol);

  // Session-count chip (how many sessions this task is associated with).
  const sessCount = Array.isArray(ctx.sessions) ? ctx.sessions.length : 0;
  if (sessCount > 0) {
    const chip = document.createElement('span');
    chip.className = 'task-sess-chip';
    chip.textContent = `⛓ ${sessCount}`;
    chip.title = `${sessCount} associated session${sessCount > 1 ? 's' : ''}`;
    row.appendChild(chip);
  }

  // Status badge
  const status = task.status || 'open';
  if (STATUS_LABEL[status]) {
    const badge = document.createElement('span');
    badge.className = 'task-status-badge ' + (STATUS_CLASS[status] || '');
    badge.textContent = STATUS_LABEL[status];
    row.appendChild(badge);
  }

  // Last-touched relative time badge.
  const touch = lastTouchSignal(task);
  if (touch) {
    const tEl = document.createElement('span');
    tEl.className = 'task-touched ' + touch.tierClass;
    tEl.textContent = touch.label;
    tEl.title = `${touch.source} · ${touch.iso}`;
    row.appendChild(tEl);
  }

  // Parse-error indicator (TaskStore marked it)
  if (task._parseError) {
    const err = document.createElement('span');
    err.className = 'task-parse-error';
    err.textContent = '⚠'; // ⚠
    err.title = task._parseError;
    row.appendChild(err);
  }

  // Expand / collapse arrow (rightmost) — toggles the associated-sessions
  // detail panel. Like the session card's expand button.
  if (typeof ctx.onExpandToggle === 'function') {
    const exBtn = document.createElement('button');
    exBtn.className = 'task-expand-btn';
    exBtn.textContent = ctx.expanded ? '▾' : '▸'; // ▾ / ▸
    exBtn.title = 'Show associated sessions';
    exBtn.onclick = (e) => {
      e.stopPropagation();
      ctx.onExpandToggle(ctx.expanded ? null : task.id);
    };
    row.appendChild(exBtn);
  }

  card.appendChild(row);

  // Detail panel (associated sessions) — only when expanded.
  if (ctx.expanded) {
    card.appendChild(buildTaskDetail(task, ctx));
  }

  // Click row body → select (ignore clicks on inline buttons / detail panel).
  row.addEventListener('click', (e) => {
    if (e.target.closest('.task-pin-btn, .task-expand-btn, .task-card-id')) return;
    if (typeof ctx.onSelect === 'function') ctx.onSelect(task.id);
  });

  // Right-click context menu
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [
      { label: ctx.pinned ? 'Unpin from Focus' : 'Pin to Focus',
        action: () => ctx.onTogglePin && ctx.onTogglePin(task.id) },
    ];
    if (typeof ctx.onMarkTouched === 'function') {
      items.push({ separator: true });
      items.push({ label: '✓ Mark touched now',
        action: () => ctx.onMarkTouched(task.id) });
    }
    if (task._path && typeof ctx.onOpenFile === 'function') {
      items.push({ separator: true });
      items.push({ label: 'Open task file', action: () => ctx.onOpenFile(task._path) });
    }
    showContextMenu(e.clientX, e.clientY, items);
  });

  return card;
}

/**
 * Detail panel shown when a task card is expanded: the list of sessions
 * associated with this task, plus a "claim focused session" button.
 *
 * ctx.sessions: [{ key, session, bound }]  (from TaskManager.resolveTaskSessions)
 *   - session: the resolved session object (or null if the bound key points
 *     at a session no longer on disk)
 *   - bound: true = explicit (task.sessions/extras) | false = cwd-inferred guess
 * ctx.onOpenSession(key) / ctx.onUnbindSession(key) / ctx.onBindFocused(taskId)
 */
function buildTaskDetail(task, ctx) {
  const panel = document.createElement('div');
  panel.className = 'task-detail-panel';
  panel.addEventListener('click', (e) => e.stopPropagation()); // don't select the card

  const sessions = Array.isArray(ctx.sessions) ? ctx.sessions : [];

  const header = document.createElement('div');
  header.className = 'task-detail-header';
  header.textContent = sessions.length
    ? `Associated sessions (${sessions.length})`
    : 'No associated sessions yet';
  panel.appendChild(header);

  for (const { key, session, bound } of sessions) {
    const r = document.createElement('div');
    r.className = 'task-sess-row';

    // status dot
    const sdot = document.createElement('span');
    sdot.className = 'task-sess-dot';
    const st = session?.status || 'stopped';
    sdot.style.background = st === 'live' ? 'var(--green,#2ecc71)'
      : st === 'tmux' ? 'var(--blue,#3498db)'
      : st === 'stopped' ? 'var(--text-dim)' : 'var(--yellow,#f39c12)';
    sdot.title = st;
    r.appendChild(sdot);

    // name (or raw key if session not resolvable)
    const nameEl = document.createElement('span');
    nameEl.className = 'task-sess-name';
    nameEl.textContent = session
      ? (session.webuiName || session.name || key.slice(key.indexOf(':') + 1, key.indexOf(':') + 9))
      : `${key.slice(key.indexOf(':') + 1, key.indexOf(':') + 9)}… (missing)`;
    nameEl.title = key;
    if (session) {
      nameEl.classList.add('clickable');
      nameEl.onclick = () => ctx.onOpenSession && ctx.onOpenSession(key);
    }
    r.appendChild(nameEl);

    // bound vs inferred tag
    const tag = document.createElement('span');
    tag.className = 'task-sess-tag ' + (bound ? 'bound' : 'inferred');
    tag.textContent = bound ? '🔒 bound' : '~ inferred';
    tag.title = bound
      ? 'Explicitly bound to this task (in frontmatter)'
      : 'Guessed from the task folder — bind it to make it stick';
    r.appendChild(tag);

    // unbind (only meaningful for explicit binds)
    if (bound && typeof ctx.onUnbindSession === 'function') {
      const ub = document.createElement('button');
      ub.className = 'task-sess-unbind';
      ub.textContent = '✕';
      ub.title = 'Unbind from this task';
      ub.onclick = () => ctx.onUnbindSession(key);
      r.appendChild(ub);
    } else if (!bound && typeof ctx.onBindKey === 'function') {
      // offer to promote an inferred session to a real bind
      const bb = document.createElement('button');
      bb.className = 'task-sess-bindone';
      bb.textContent = '🔒';
      bb.title = 'Bind this session to the task';
      bb.onclick = () => ctx.onBindKey(key);
      r.appendChild(bb);
    }

    panel.appendChild(r);
  }

  // Action row: spawn a new dedicated session / claim the focused one.
  const actions = document.createElement('div');
  actions.className = 'task-detail-actions';

  // "+ new session" — spawns a fresh chat session in the task's context
  // folder, auto-binds it, and sends the onboarding message (read TASK.md).
  if (typeof ctx.onSpawnSession === 'function') {
    const spawn = document.createElement('button');
    spawn.className = 'task-detail-claim';
    spawn.innerHTML = '➕ 为此 task 开新 session';
    spawn.title = 'New chat session in this task\'s context folder — auto-bound, onboarded with TASK.md';
    spawn.onclick = () => {
      spawn.disabled = true;
      spawn.innerHTML = '⏳ 创建中…';
      ctx.onSpawnSession(task.id);
    };
    actions.appendChild(spawn);
  }

  // "Claim focused session" — binds whatever chat/terminal window is
  // currently focused to this task (the button-based binding trigger).
  if (typeof ctx.onBindFocused === 'function') {
    const claim = document.createElement('button');
    claim.className = 'task-detail-claim';
    claim.innerHTML = '🔗 认领当前 session';
    claim.title = 'Bind the currently focused session window to this task';
    claim.onclick = () => ctx.onBindFocused(task.id);
    actions.appendChild(claim);
  }

  if (actions.children.length) panel.appendChild(actions);

  return panel;
}

export const TASK_PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };

/**
 * Returns a {iso, ms, source} for the "most relevant timestamp" used to drive
 * the relative-time badge AND the Last-touched sort. Preference order matches
 * the doc: last_touched_at (canonical) → updated (frontmatter mtime) →
 * created. Returns null only if all three are missing.
 */
export function lastTouchTimestamp(task) {
  for (const field of ['last_touched_at', 'updated', 'created']) {
    const v = task?.[field];
    if (!v) continue;
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return { iso: v, ms, source: field };
  }
  return null;
}

/**
 * For the task card label only — wraps lastTouchTimestamp with a relative
 * string ('5d', '2h', 'just now', '3w') and a CSS tier class. Tier
 * thresholds match the doc's color guidance (≤1d / 1-3d / 4-7d / 8+d).
 */
export function lastTouchSignal(task) {
  const ts = lastTouchTimestamp(task);
  if (!ts) return null;
  const now = Date.now();
  const diffMs = Math.max(0, now - ts.ms);
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const min = 60 * 1000;

  let label;
  if (diffMs < min) label = 'now';
  else if (diffMs < hour) label = `${Math.floor(diffMs / min)}m`;
  else if (diffMs < day) label = `${Math.floor(diffMs / hour)}h`;
  else if (diffMs < 7 * day) label = `${Math.floor(diffMs / day)}d`;
  else if (diffMs < 30 * day) label = `${Math.floor(diffMs / (7 * day))}w`;
  else label = `${Math.floor(diffMs / (30 * day))}mo`;

  let tierClass;
  if (diffMs <= day) tierClass = 'tier-fresh';
  else if (diffMs <= 3 * day) tierClass = 'tier-normal';
  else if (diffMs <= 7 * day) tierClass = 'tier-warn';
  else tierClass = 'tier-stale';

  return { label, tierClass, iso: ts.iso, source: ts.source };
}

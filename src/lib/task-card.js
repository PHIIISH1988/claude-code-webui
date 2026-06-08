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
    + (ctx.subTask ? ' subtask' : '');
  card.dataset.taskId = task.id;
  card.title = task.id + (task.title ? ` — ${task.title}` : '');

  // Pin toggle (left-most)
  const pinBtn = document.createElement('button');
  pinBtn.className = 'task-pin-btn' + (ctx.pinned ? ' active' : '');
  pinBtn.innerHTML = ctx.pinned ? '★' : '☆'; // ★ vs ☆
  pinBtn.title = ctx.pinned ? 'Unpin from Focus' : 'Pin to Focus';
  pinBtn.onclick = (e) => {
    e.stopPropagation();
    if (typeof ctx.onTogglePin === 'function') ctx.onTogglePin(task.id);
  };
  card.appendChild(pinBtn);

  // Priority dot
  const dot = document.createElement('span');
  dot.className = 'task-priority-dot';
  dot.style.background = PRIORITY_COLOR[task.priority] || PRIORITY_COLOR.normal;
  dot.title = `priority: ${task.priority || 'normal'}`;
  card.appendChild(dot);

  // Two-line text column: line 1 = task id (编号), line 2 = title.
  // Walter references tasks to agents by id, so the id is shown explicitly
  // and clicking it copies the full id to the clipboard (stops propagation
  // so it doesn't also trigger the card's select/activate).
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

  card.appendChild(textCol);

  // Status badge
  const status = task.status || 'open';
  if (STATUS_LABEL[status]) {
    const badge = document.createElement('span');
    badge.className = 'task-status-badge ' + (STATUS_CLASS[status] || '');
    badge.textContent = STATUS_LABEL[status];
    card.appendChild(badge);
  }

  // Last-touched relative time badge (per TASK-SYSTEM-DESIGN § 2.11).
  // Falls back to `updated` then `created` so old tasks (no field) still
  // show *something*; otherwise Walter would see '—' on every legacy task
  // and lose the at-a-glance staleness signal entirely.
  const touch = lastTouchSignal(task);
  if (touch) {
    const tEl = document.createElement('span');
    tEl.className = 'task-touched ' + touch.tierClass;
    tEl.textContent = touch.label;
    tEl.title = `${touch.source} · ${touch.iso}`;
    card.appendChild(tEl);
  }

  // Parse-error indicator (TaskStore marked it)
  if (task._parseError) {
    const err = document.createElement('span');
    err.className = 'task-parse-error';
    err.textContent = '⚠'; // ⚠
    err.title = task._parseError;
    card.appendChild(err);
  }

  // Click card body → select
  card.addEventListener('click', (e) => {
    if (e.target.closest('.task-pin-btn')) return;
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

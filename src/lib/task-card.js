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

import { escHtml, showContextMenu } from './utils.js';

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

  // Title (or id if no title)
  const title = document.createElement('span');
  title.className = 'task-card-title';
  title.textContent = task.title || task.id;
  card.appendChild(title);

  // Status badge
  const status = task.status || 'open';
  if (STATUS_LABEL[status]) {
    const badge = document.createElement('span');
    badge.className = 'task-status-badge ' + (STATUS_CLASS[status] || '');
    badge.textContent = STATUS_LABEL[status];
    card.appendChild(badge);
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
    if (task._path && typeof ctx.onOpenFile === 'function') {
      items.push({ separator: true });
      items.push({ label: 'Open task file', action: () => ctx.onOpenFile(task._path) });
    }
    showContextMenu(e.clientX, e.clientY, items);
  });

  return card;
}

export const TASK_PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };

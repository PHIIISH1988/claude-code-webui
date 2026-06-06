/**
 * Sidebar Tasks-tab rendering — mixin installed on Sidebar.prototype.
 *
 * Layout:
 *   ┌─────────────────────────────────────┐
 *   │ Group by: [Workspace ▾]  Sort: [▾]  │  ← tools row
 *   ├─────────────────────────────────────┤
 *   │ 🎯 Focus (N)                        │  ← sticky at top
 *   │   <task-card>                       │
 *   │   <task-card>                       │
 *   ├─────────────────────────────────────┤
 *   │ ▼ finance (3)                       │  ← collapsible group header
 *   │   <task-card>                       │
 *   │   <task-card>                       │
 *   │ ▼ legal (5)                         │
 *   │   ...                               │
 *   └─────────────────────────────────────┘
 *
 * Phase 2 scope: Pin/Unpin works, group-by + sort work, click selects (no
 * workspace switch yet). All driven by app._allTasks + app.getFocusSlots().
 */

import { renderTaskCard, TASK_PRIORITY_ORDER } from './task-card.js';
import { escHtml, createPopover } from './utils.js';

// Persistent UI state for the Tasks tab (per browser, localStorage).
const VIEW_PREF_KEY = 'sidebar.tasks.viewPref';

function loadViewPref() {
  try {
    const raw = localStorage.getItem(VIEW_PREF_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch { return {}; }
}
function saveViewPref(p) {
  try { localStorage.setItem(VIEW_PREF_KEY, JSON.stringify(p)); } catch {}
}

const GROUP_BY_OPTIONS = [
  { value: 'workspace', label: 'Workspace' },
  { value: 'priority',  label: 'Priority' },
  { value: 'status',    label: 'Status' },
  { value: 'none',      label: 'No grouping' },
];

const SORT_OPTIONS = [
  { value: 'priority', label: 'Priority' },
  { value: 'updated',  label: 'Updated' },
  { value: 'created',  label: 'Created' },
  { value: 'title',    label: 'Title' },
];

export function installSidebarRenderTasks(SidebarClass) {
  const proto = SidebarClass.prototype;

  // Initialize per-tab UI state on first render (lazy).
  proto._ensureTaskViewState = function() {
    if (this._taskView) return;
    const pref = loadViewPref();
    this._taskView = {
      groupBy: pref.groupBy || 'workspace',
      sort:    pref.sort    || 'priority',
      collapsedGroups: new Set(pref.collapsedGroups || []),
    };
    // Re-render on focus-slot changes from other tabs / servers
    if (typeof this.app.onFocusChanged === 'function') {
      this.app.onFocusChanged(() => {
        if (this._activeTab === 'tasks') this._render();
      });
    }
  };

  proto._saveTaskViewPref = function() {
    if (!this._taskView) return;
    saveViewPref({
      groupBy: this._taskView.groupBy,
      sort:    this._taskView.sort,
      collapsedGroups: Array.from(this._taskView.collapsedGroups),
    });
  };

  // Main entry — called from _renderInner when _activeTab === 'tasks'
  proto._renderTasks = function() {
    this._ensureTaskViewState();

    const tasks = (this.app._allTasks || []).filter(t => {
      // hide archived from default view (Phase 2: no toggle yet — just hide)
      if (t.archived_at) return false;
      // hide done by default too (they're noise once archived)
      if (t.status === 'done') return false;
      return true;
    });

    // Apply text filter (re-use existing #session-filter input — same box,
    // different matching scope for Tasks tab).
    const f = (document.getElementById('session-filter')?.value || '').toLowerCase();
    const filtered = f ? tasks.filter(t =>
      ((t.id || '').toLowerCase().includes(f))
      || ((t.title || '').toLowerCase().includes(f))
      || ((t.context_folder || '').toLowerCase().includes(f))
      || ((t.priority || '').toLowerCase().includes(f))
      || ((t.status || '').toLowerCase().includes(f))
    ) : tasks;

    this.listEl.appendChild(this._buildTaskTools());
    this.listEl.appendChild(this._buildFocusArea(filtered));
    this.listEl.appendChild(this._buildTaskGroups(filtered));
  };

  // ── Tools row (Group by + Sort) ──
  proto._buildTaskTools = function() {
    const row = document.createElement('div');
    row.className = 'task-tools-row';

    const grpBtn = document.createElement('button');
    grpBtn.className = 'task-tools-btn';
    grpBtn.textContent = labelFor(GROUP_BY_OPTIONS, this._taskView.groupBy, 'Group');
    grpBtn.onclick = () => this._openSelectPopover(grpBtn, 'Group by', GROUP_BY_OPTIONS, this._taskView.groupBy, (v) => {
      this._taskView.groupBy = v; this._saveTaskViewPref(); this._render();
    });

    const sortBtn = document.createElement('button');
    sortBtn.className = 'task-tools-btn';
    sortBtn.textContent = labelFor(SORT_OPTIONS, this._taskView.sort, 'Sort');
    sortBtn.onclick = () => this._openSelectPopover(sortBtn, 'Sort', SORT_OPTIONS, this._taskView.sort, (v) => {
      this._taskView.sort = v; this._saveTaskViewPref(); this._render();
    });

    row.append('Group: ', grpBtn, '  Sort: ', sortBtn);
    return row;
  };

  proto._openSelectPopover = function(anchor, title, options, current, onPick) {
    const pop = createPopover(anchor, 'task-tools-popover');
    const head = document.createElement('div');
    head.className = 'task-tools-popover-title';
    head.textContent = title;
    pop.appendChild(head);
    for (const opt of options) {
      const item = document.createElement('div');
      item.className = 'task-tools-popover-item' + (opt.value === current ? ' active' : '');
      item.textContent = opt.label;
      item.onclick = () => { pop.remove(); onPick(opt.value); };
      pop.appendChild(item);
    }
  };

  // ── Focus area (sticky at top) ──
  proto._buildFocusArea = function(allTasks) {
    const focusIds = (this.app.getFocusSlots && this.app.getFocusSlots()) || [];
    const wrap = document.createElement('div');
    wrap.className = 'task-focus-area';

    const header = document.createElement('div');
    header.className = 'task-focus-header';
    header.innerHTML = `<span class="task-focus-title">🎯 Focus</span><span class="task-focus-count">${focusIds.length}</span>`;
    wrap.appendChild(header);

    if (focusIds.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'task-focus-empty';
      empty.textContent = 'Click ☆ on any task below to pin it here.';
      wrap.appendChild(empty);
      return wrap;
    }

    const taskById = new Map((this.app._allTasks || []).map(t => [t.id, t]));
    for (const id of focusIds) {
      const t = taskById.get(id);
      if (!t) {
        // Task removed from disk — show stub so user can unpin
        const stub = document.createElement('div');
        stub.className = 'task-item-card task-stub';
        stub.innerHTML = `<span class="task-card-title">${escHtml(id)}</span><span class="task-status-badge badge-task-missing">MISSING</span>`;
        const unpinBtn = document.createElement('button');
        unpinBtn.className = 'task-pin-btn active';
        unpinBtn.innerHTML = '×';
        unpinBtn.title = 'Unpin (task file no longer exists)';
        unpinBtn.onclick = (e) => {
          e.stopPropagation();
          this.app.unpinTaskFromFocus(id);
        };
        stub.prepend(unpinBtn);
        wrap.appendChild(stub);
        continue;
      }
      wrap.appendChild(this._buildTaskCard(t, /* selected */ false));
    }
    return wrap;
  };

  // ── Grouped task list ──
  proto._buildTaskGroups = function(tasks) {
    const wrap = document.createElement('div');
    wrap.className = 'task-list-area';

    const sorted = this._sortTasks(tasks.slice());

    if (this._taskView.groupBy === 'none') {
      for (const t of sorted) wrap.appendChild(this._buildTaskCard(t, false));
      return wrap;
    }

    // Group → render
    const groups = this._groupTasks(sorted, this._taskView.groupBy);
    for (const [groupKey, items] of groups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'task-group';
      const isCollapsed = this._taskView.collapsedGroups.has(groupKey);
      if (isCollapsed) groupEl.classList.add('collapsed');

      const header = document.createElement('div');
      header.className = 'task-group-header';
      header.innerHTML = `<span class="task-group-chevron">▼</span><span class="task-group-name">${escHtml(groupKey)}</span><span class="task-group-count">${items.length}</span>`;
      header.onclick = () => {
        if (this._taskView.collapsedGroups.has(groupKey)) this._taskView.collapsedGroups.delete(groupKey);
        else this._taskView.collapsedGroups.add(groupKey);
        this._saveTaskViewPref();
        groupEl.classList.toggle('collapsed');
      };
      groupEl.appendChild(header);

      const body = document.createElement('div');
      body.className = 'task-group-body';
      for (const t of items) body.appendChild(this._buildTaskCard(t, false));
      groupEl.appendChild(body);
      wrap.appendChild(groupEl);
    }
    return wrap;
  };

  proto._buildTaskCard = function(task, selected) {
    return renderTaskCard(task, {
      pinned: this.app.isTaskInFocus(task.id),
      selected,
      subTask: !!task.part_of,
      onTogglePin: (id) => {
        if (this.app.isTaskInFocus(id)) this.app.unpinTaskFromFocus(id);
        else this.app.pinTaskToFocus(id);
        // Re-render immediately for the originator. The server SyncStore
        // broadcast deliberately excludes the sender (to avoid loops), so
        // the onFocusChanged listener only fires on *other* tabs. Without
        // this manual render the pinning feedback feels delayed and Walter
        // has to click somewhere else to see the change.
        this._render();
      },
      onSelect: (id) => {
        // Phase 2 — just visual selection. Workspace switching is Phase 3.
        this._selectedTaskId = id;
        this._render();
      },
      onOpenFile: (filePath) => {
        if (typeof this.app.openEditor === 'function') {
          this.app.openEditor(filePath, filePath.split('/').pop());
        }
      },
    });
  };

  // ── Grouping ──
  proto._groupTasks = function(tasks, by) {
    const groups = new Map();
    for (const t of tasks) {
      const key = this._groupKeyOf(t, by);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    // Stable group order:
    //   workspace → alpha
    //   priority  → urgent first
    //   status    → in_progress first
    const order = sortedGroupKeys(by, Array.from(groups.keys()));
    return order.map(k => [k, groups.get(k)]);
  };

  proto._groupKeyOf = function(t, by) {
    if (by === 'workspace') {
      // context_folder examples: 'hr_contractor-management_260320'
      // workspace == top-level claude-ops/workspaces/{ws} folder.
      // We can't perfectly recover ws from context_folder alone for nested
      // workspaces, but in practice the prefix (before first '_') is the ws.
      const cf = t.context_folder || '';
      const first = cf.split('_')[0];
      return first || '(unknown)';
    }
    if (by === 'priority') return t.priority || 'normal';
    if (by === 'status')   return t.status || 'open';
    return '(other)';
  };

  // ── Sorting ──
  proto._sortTasks = function(tasks) {
    const by = this._taskView.sort;
    if (by === 'priority') {
      return tasks.sort((a, b) => {
        const pa = TASK_PRIORITY_ORDER[a.priority] ?? 2;
        const pb = TASK_PRIORITY_ORDER[b.priority] ?? 2;
        if (pa !== pb) return pa - pb;
        // tie-break by updated desc
        return (b.updated || '').localeCompare(a.updated || '');
      });
    }
    if (by === 'updated') return tasks.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    if (by === 'created') return tasks.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    if (by === 'title')   return tasks.sort((a, b) => (a.title || a.id || '').localeCompare(b.title || b.id || ''));
    return tasks;
  };
}

// ── helpers ────────────────────────────────────────────────────

function labelFor(options, value, fallbackLabel) {
  const m = options.find(o => o.value === value);
  return m ? m.label : fallbackLabel;
}

function sortedGroupKeys(by, keys) {
  if (by === 'priority') {
    const order = ['urgent', 'high', 'normal', 'low'];
    return keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
  if (by === 'status') {
    const order = ['in_progress', 'open', 'blocked', 'proposed', 'done', 'abandoned'];
    return keys.sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }
  // workspace / fallback — alpha
  return keys.sort();
}

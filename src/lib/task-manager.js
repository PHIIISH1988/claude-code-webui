/**
 * TaskManager — drives the dedicated Task Desktop workspace (Phase 3.5).
 *
 * Design history:
 *
 *   v1 — "filter the current desktop". Walter rejected: it polluted his
 *        Finance/Dev desktops.
 *   v2 — "borrow into a system Task Desktop". Got 80% there but had three
 *        sharp bugs Walter spotted:
 *          (a) no auto-layout — windows piled on top of each other
 *          (b) A→B switch leaked: task A's auto-spawned windows stayed
 *              visible when entering task B
 *          (c) context_folder inference returned ALL sessions in that
 *              folder, so forky tasks (9 sessions for one task) flooded
 *              the workspace
 *   v3 (this) — fixes all three plus lays groundwork for explicit session
 *               locking via task.extras.
 *
 * Key invariants:
 *
 *   - Each window that lands in Task Desktop has an entry in _members:
 *       { borrowed: bool, origDesktopId: string|null, taskId: string }
 *     borrowed=true → came from another desktop (origDesktopId set), goes
 *     back there on leave. borrowed=false → auto-spawned for the task,
 *     limbos on Task Desktop when not in the active task's set.
 *
 *   - Visibility uses TWO independent flags:
 *       _hiddenByDesktop — DesktopManager owns this. Set when window's
 *                          _desktopId !== activeDesktop.
 *       _hiddenByTask    — TaskManager owns this. Set when window is on
 *                          Task Desktop but not in the active task's set
 *                          (e.g. a limbo'd auto-spawn from a previous
 *                          task). Composes with _hiddenByDesktop.
 *     DesktopManager._showWin was patched to respect _hiddenByTask so it
 *     doesn't accidentally reveal limbo windows on re-entry.
 *
 *   - Inference is now CAPPED at one session per task by default.
 *     The "best" pick is the most-recently-started session (proxy for
 *     "the fork tip Walter is actually using"), preferring live > stopped.
 *     If Walter needs more sessions associated with a task, he locks
 *     them explicitly into task.extras via the right-click "Lock to
 *     current task" UI (Phase 3.5b).
 *
 *   - Layout: after a task is activated we auto-arrange visible windows
 *     into a sensible grid (N=1 maximize, N=2 two-cols, N=4 quad, etc).
 *     Round-robin via wm.applyLayout. This is one-shot; Walter can drag
 *     things around afterwards without us re-fighting him.
 */

import { DesktopManager } from './desktop-manager.js';

const TASK_DESKTOP_ID = DesktopManager.TASK_DESKTOP_ID;

function gridForCount(n) {
  if (n <= 1) return 'maximize';
  if (n === 2) return 'two-vertical';
  if (n === 3) return 'three-columns';
  if (n === 4) return 'quad';
  if (n <= 6) return 'grid-2-3';
  if (n <= 9) return 'grid-3-3';
  if (n <= 12) return 'grid-3-4';
  if (n <= 16) return 'grid-4-4';
  return 'grid-4-' + Math.ceil(n / 4);
}

export class TaskManager {
  constructor(app) {
    this.app = app;
    this._activeTaskId = null;
    this._members = new Map();
    this._topBar = null;
    this._listeners = new Set();
    this._hookDesktopSwitch();
  }

  getActiveTaskId() { return this._activeTaskId; }
  getActiveTask() {
    if (!this._activeTaskId) return null;
    return this.app._taskById?.get(this._activeTaskId) || null;
  }
  onActiveTaskChanged(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  async setActiveTask(taskId) {
    const next = taskId || null;
    if (this._activeTaskId === next) return;

    const dm = this.app.desktopManager;
    if (!dm) return;

    if (!next) {
      this._teardownAllMembers();
      this._activeTaskId = null;
      const fallback = dm.desktops.find(d => d.id !== TASK_DESKTOP_ID);
      if (fallback) {
        this._inProgrammaticSwitch = true;
        try { await dm.switchTo(fallback.id); } finally { this._inProgrammaticSwitch = false; }
      }
      this._renderTopBar();
      this._notify();
      return;
    }

    const wasOnTaskDesktop = dm.activeDesktopId === TASK_DESKTOP_ID;
    this._activeTaskId = next;

    if (!wasOnTaskDesktop) {
      this._inProgrammaticSwitch = true;
      try { await dm.switchTo(TASK_DESKTOP_ID); } finally { this._inProgrammaticSwitch = false; }
    }

    this._reconcileMembersAgainstActiveTask();
    this._borrowTaskWindows();
    this._spawnMissingTaskSessions();
    this._scheduleAutoLayout();
    this._renderTopBar();
    this._notify();
  }

  clearActiveTask() { return this.setActiveTask(null); }

  refresh() {
    if (this._activeTaskId) {
      this._reconcileMembersAgainstActiveTask();
      this._borrowTaskWindows();
    }
    this._renderTopBar();
  }

  // ── Session association ──────────────────────────────────────

  getTaskSessionKeys(task) {
    if (!task) return new Set();
    const set = new Set();
    const declared = Array.isArray(task.sessions) ? task.sessions.filter(Boolean) : [];
    const extras = Array.isArray(task.extras) ? task.extras.filter(Boolean) : [];
    if (declared.length > 0) {
      for (const k of declared) set.add(k);
    } else {
      const best = this._inferBestSessionByContextFolder(task.context_folder);
      if (best) set.add(best);
    }
    for (const k of extras) set.add(k);
    return set;
  }

  _inferBestSessionByContextFolder(contextFolder) {
    if (!contextFolder) return null;
    const sessions = this.app.sidebar?._allSessions || [];
    const matches = [];
    for (const s of sessions) {
      if (!s.cwd) continue;
      const cwdLast = s.cwd.replace(/\/+$/, '').split('/').pop();
      if (cwdLast !== contextFolder) continue;
      const id = s.backendSessionId || s.sessionId;
      if (!id) continue;
      matches.push(s);
    }
    if (matches.length === 0) return null;

    const statusRank = (s) => {
      if (s.status === 'live') return 0;
      if (s.status === 'stopped') return 1;
      return 2;
    };
    matches.sort((a, b) => {
      const r = statusRank(a) - statusRank(b);
      if (r !== 0) return r;
      const ta = a.startedAt || '';
      const tb = b.startedAt || '';
      if (ta !== tb) return tb.localeCompare(ta);
      return 0;
    });
    const winner = matches[0];
    const backend = winner.backend || 'claude';
    const id = winner.backendSessionId || winner.sessionId;
    return `${backend}:${id}`;
  }

  // ── Member tracking ──────────────────────────────────────────

  _sessionKeyForWindow(winId, win) {
    const term = this.app.sessions?.get(winId);
    const allSess = this.app.sidebar?._allSessions || [];
    if (term?.sessionId) {
      const match = allSess.find(s => s.webuiId === term.sessionId);
      if (match) {
        const backend = match.backend || 'claude';
        const id = match.backendSessionId || match.sessionId;
        if (id) return `${backend}:${id}`;
      }
    }
    const spec = win._openSpec || {};
    const backendSessionId = spec.backendSessionId || spec.sessionId;
    const backend = spec.backend || 'claude';
    if (backendSessionId) return `${backend}:${backendSessionId}`;
    return null;
  }

  _borrowTaskWindows() {
    const task = this.getActiveTask();
    if (!task) return;
    const allowed = this.getTaskSessionKeys(task);
    const wm = this.app.wm;
    if (!wm) return;

    for (const [winId, win] of wm.windows) {
      if (win.type !== 'chat' && win.type !== 'terminal') continue;
      if (this._members.has(winId)) continue;
      const key = this._sessionKeyForWindow(winId, win);
      if (!key || !allowed.has(key)) continue;
      if (win._desktopId === TASK_DESKTOP_ID) {
        this._members.set(winId, {
          borrowed: false,
          origDesktopId: null,
          taskId: this._activeTaskId,
        });
      } else {
        this._members.set(winId, {
          borrowed: true,
          origDesktopId: win._desktopId,
          taskId: this._activeTaskId,
        });
        win._desktopId = TASK_DESKTOP_ID;
      }
      this._show(win);
    }
    wm._reflowWindows?.();
  }

  _reconcileMembersAgainstActiveTask() {
    const task = this.getActiveTask();
    if (!task) return;
    const allowed = this.getTaskSessionKeys(task);
    const wm = this.app.wm;
    if (!wm) return;
    const dm = this.app.desktopManager;

    for (const [winId, meta] of [...this._members]) {
      const win = wm.windows.get(winId);
      if (!win) { this._members.delete(winId); continue; }
      const key = this._sessionKeyForWindow(winId, win);
      const isMatch = key && allowed.has(key);

      if (isMatch) {
        meta.taskId = this._activeTaskId;
        this._show(win);
      } else {
        if (meta.borrowed) {
          win._desktopId = meta.origDesktopId || (dm?.desktops[0]?.id);
          this._hideByDesktop(win);
          this._members.delete(winId);
        } else {
          this._hideByTask(win);
        }
      }
    }
  }

  _teardownAllMembers() {
    const wm = this.app.wm;
    const dm = this.app.desktopManager;
    if (!wm || !dm) return;
    for (const [winId, meta] of this._members) {
      const win = wm.windows.get(winId);
      if (!win) continue;
      if (meta.borrowed) {
        win._desktopId = meta.origDesktopId || dm.desktops[0]?.id;
        this._hideByDesktop(win);
      } else {
        this._hideByDesktop(win);
        if (win._hiddenByTask) win._hiddenByTask = false;
      }
    }
  }

  // ── Auto-resume / attach ─────────────────────────────────────

  _spawnMissingTaskSessions() {
    const task = this.getActiveTask();
    if (!task) return;
    const allowed = this.getTaskSessionKeys(task);
    if (allowed.size === 0) return;

    const allSess = this.app.sidebar?._allSessions || [];
    const wm = this.app.wm;
    if (!wm) return;

    const haveWindow = new Set();
    for (const [winId, win] of wm.windows) {
      if (win._desktopId !== TASK_DESKTOP_ID) continue;
      if (win._hiddenByTask) continue;
      const k = this._sessionKeyForWindow(winId, win);
      if (k) haveWindow.add(k);
    }

    for (const key of allowed) {
      if (haveWindow.has(key)) continue;
      let revived = false;
      for (const [winId, meta] of this._members) {
        const win = wm.windows.get(winId);
        if (!win || !win._hiddenByTask) continue;
        const k = this._sessionKeyForWindow(winId, win);
        if (k === key) {
          this._show(win);
          meta.taskId = this._activeTaskId;
          revived = true;
          break;
        }
      }
      if (revived) continue;

      const colon = key.indexOf(':');
      if (colon < 0) continue;
      const backend = key.slice(0, colon);
      const backendSessionId = key.slice(colon + 1);
      const sess = allSess.find(s =>
        (s.backendSessionId || s.sessionId) === backendSessionId &&
        (s.backend || 'claude') === backend);
      if (!sess) continue;

      const agentOpts = {
        backend,
        backendSessionId,
        agentKind: sess.agentKind || 'primary',
        agentRole: sess.agentRole || '',
        agentNickname: sess.agentNickname || '',
        sourceKind: sess.sourceKind || '',
        parentThreadId: sess.parentThreadId || null,
      };
      try {
        if (sess.status === 'live' && sess.webuiId) {
          this.app.attachSession(sess.webuiId, sess.webuiName || sess.name, sess.cwd,
            { mode: sess.webuiMode || 'chat', ...agentOpts });
        } else if (sess.status === 'stopped') {
          this.app.resumeSession(sess.sessionId, sess.cwd, sess.name,
            { mode: 'chat', ...agentOpts });
        }
      } catch {}
    }
  }

  // ── Layout ───────────────────────────────────────────────────

  _scheduleAutoLayout() {
    requestAnimationFrame(() => this._applyAutoLayout());
    setTimeout(() => this._applyAutoLayout(), 1500);
  }

  _applyAutoLayout() {
    const wm = this.app.wm;
    const dm = this.app.desktopManager;
    if (!wm || !dm) return;
    if (dm.activeDesktopId !== TASK_DESKTOP_ID) return;
    const visible = [...wm.windows.values()].filter(w =>
      !w.isMinimized && !w._hiddenByDesktop && !w._hiddenByTask
      && w._desktopId === TASK_DESKTOP_ID
      && !(w._tabChain && w._tabChain.tabs[0] !== w.id));
    if (visible.length === 0) return;
    wm.applyLayout(gridForCount(visible.length));
  }

  // ── Visibility helpers ───────────────────────────────────────

  _show(win) {
    if (win._hiddenByTask) win._hiddenByTask = false;
    if (win._hiddenByDesktop) win._hiddenByDesktop = false;
    win.element.style.visibility = '';
    win.element.style.pointerEvents = '';
  }
  _hideByDesktop(win) {
    win._hiddenByDesktop = true;
    win.element.style.visibility = 'hidden';
    win.element.style.pointerEvents = 'none';
  }
  _hideByTask(win) {
    win._hiddenByTask = true;
    win.element.style.visibility = 'hidden';
    win.element.style.pointerEvents = 'none';
  }

  // ── Desktop switch hook ──────────────────────────────────────

  _hookDesktopSwitch() {
    const dm = this.app.desktopManager;
    if (!dm) return;
    const orig = dm.switchTo.bind(dm);
    dm.switchTo = async (desktopId) => {
      if (this._inProgrammaticSwitch) return orig(desktopId);
      if (this._activeTaskId && desktopId !== TASK_DESKTOP_ID) {
        this._teardownAllMembers();
        this._activeTaskId = null;
        this._renderTopBar();
        if (this.app.sidebar?._activeTab === 'tasks') this.app.sidebar._render();
        this._notify();
      }
      return orig(desktopId);
    };
  }

  // ── Top breadcrumb ───────────────────────────────────────────

  _renderTopBar() {
    if (!this._topBar) {
      const toolbar = document.getElementById('toolbar');
      if (!toolbar) return;
      const bar = document.createElement('div');
      bar.className = 'task-active-bar';
      bar.innerHTML = `
        <span class="task-active-label">🎯</span>
        <span class="task-active-name"></span>
        <span class="task-active-status"></span>
        <button class="task-active-back" title="Leave Task Desktop">× Leave</button>
      `;
      toolbar.appendChild(bar);
      bar.querySelector('.task-active-back').onclick = () => this.clearActiveTask();
      this._topBar = bar;
    }
    const task = this.getActiveTask();
    if (!task) { this._topBar.classList.remove('active'); return; }
    this._topBar.classList.add('active');
    this._topBar.querySelector('.task-active-name').textContent = task.title || task.id;
    this._topBar.querySelector('.task-active-name').title =
      task.id + (task.title ? ` — ${task.title}` : '');
    const statusEl = this._topBar.querySelector('.task-active-status');
    const status = task.status || 'open';
    const priority = task.priority || 'normal';
    statusEl.textContent = `${status} · ${priority}`;
    statusEl.className = `task-active-status status-${status} priority-${priority}`;
  }

  _notify() {
    for (const fn of this._listeners) { try { fn(this._activeTaskId); } catch {} }
  }
}

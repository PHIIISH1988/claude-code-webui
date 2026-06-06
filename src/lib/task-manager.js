/**
 * TaskManager — drives the "Task Desktop" workspace (Phase 3 v2).
 *
 * Design (revised per Walter's feedback 2026-06-06):
 *
 *   - There is exactly ONE system Task Desktop, registered in DesktopManager
 *     under the id DesktopManager.TASK_DESKTOP_ID. It's not deletable and
 *     it lives at the rightmost slot of the desktop tab strip. Walter
 *     switches *to* this desktop by clicking any task in the sidebar.
 *
 *   - The Task Desktop's content is dynamic — driven by which task is
 *     currently active. Clicking a different task in the sidebar swaps the
 *     contents in-place without leaving the Task Desktop.
 *
 *   - User's other desktops (Finance / Legal / Dev / etc) are NEVER touched
 *     by task activation. They continue to look and behave exactly as they
 *     did before this refactor.
 *
 *   - Sessions are "borrowed" into the Task Desktop while a task is active:
 *     we save the window's original `_desktopId` in `_origDesktopId`, then
 *     overwrite `_desktopId` with TASK_DESKTOP_ID. When the user leaves
 *     (clicks another desktop tab, or clicks the active task again to
 *     toggle off), we restore the original `_desktopId`. Standard
 *     DesktopManager visibility logic does the rest — no parallel hide
 *     mechanism, no flag composition.
 *
 *   - Stopped sessions in the active task's set are auto-resumed when
 *     entering the workspace, per Walter's spec. Live sessions without
 *     windows are auto-attached. The new windows spawn directly onto the
 *     Task Desktop because we switched to it first.
 *
 *   - The Active task is NOT persisted across reloads. Boots into Default.
 */

import { DesktopManager } from './desktop-manager.js';

const TASK_DESKTOP_ID = DesktopManager.TASK_DESKTOP_ID;

export class TaskManager {
  constructor(app) {
    this.app = app;
    /** @type {string | null}  null = no task active */
    this._activeTaskId = null;
    /** Set of winIds we borrowed from other desktops while a task is active. */
    this._borrowedWinIds = new Set();
    /** Top breadcrumb element (lazily injected). */
    this._topBar = null;
    /** External listeners for activetask changes. */
    this._listeners = new Set();

    this._hookDesktopSwitch();
  }

  // ── Public API ────────────────────────────────────────────────

  getActiveTaskId() { return this._activeTaskId; }
  getActiveTask() {
    if (!this._activeTaskId) return null;
    return this.app._taskById?.get(this._activeTaskId) || null;
  }

  /**
   * Switch to the given task's workspace. Pass null/undefined to leave.
   * Idempotent if the clicked task is already active.
   */
  async setActiveTask(taskId) {
    const next = taskId || null;
    if (this._activeTaskId === next) return;

    const dm = this.app.desktopManager;
    if (!dm) return;

    // 1. If we were viewing another task already, return its borrowed windows
    //    to where they came from first. This avoids cross-task contamination.
    if (this._activeTaskId) this._restoreBorrowedWindows();

    this._activeTaskId = next;

    if (!next) {
      // Leaving the Task Desktop — pick any non-task desktop to land on.
      const fallback = dm.desktops.find(d => d.id !== TASK_DESKTOP_ID);
      if (fallback) {
        // Use the internal-switch flag so our hook doesn't fire recursively.
        this._inProgrammaticSwitch = true;
        try { await dm.switchTo(fallback.id); } finally { this._inProgrammaticSwitch = false; }
      }
      this._renderTopBar();
      this._notify();
      return;
    }

    // 2. Switch DesktopManager onto the Task Desktop. Standard hide-all-on-
    //    prev + show-on-target runs — and since no windows have
    //    _desktopId=TASK_DESKTOP_ID yet, the screen ends up empty. We fill
    //    it next via borrowing.
    if (dm.activeDesktopId !== TASK_DESKTOP_ID) {
      this._inProgrammaticSwitch = true;
      try { await dm.switchTo(TASK_DESKTOP_ID); } finally { this._inProgrammaticSwitch = false; }
    }

    // 3. Borrow windows that already exist for this task's sessions.
    this._borrowTaskWindows();

    // 4. Auto-resume / attach the rest (sessions in the set that don't have
    //    a window yet). Stopped → resumeSession; live → attachSession.
    this._spawnMissingTaskSessions();

    this._renderTopBar();
    this._notify();
  }

  clearActiveTask() { return this.setActiveTask(null); }

  /** Sidebar / other consumers can re-evaluate after task data changes. */
  refresh() {
    if (this._activeTaskId) {
      // Task data may have added/removed sessions — re-borrow.
      this._restoreBorrowedWindows();
      this._borrowTaskWindows();
    }
    this._renderTopBar();
  }

  onActiveTaskChanged(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  // ── Session association ──────────────────────────────────────

  getTaskSessionKeys(task) {
    if (!task) return new Set();
    const set = new Set();
    const declared = Array.isArray(task.sessions) ? task.sessions.filter(Boolean) : [];
    const extras = Array.isArray(task.extras) ? task.extras.filter(Boolean) : [];
    if (declared.length > 0) {
      for (const k of declared) set.add(k);
    } else {
      for (const k of this._inferSessionKeysByContextFolder(task.context_folder)) set.add(k);
    }
    for (const k of extras) set.add(k);
    return set;
  }

  _inferSessionKeysByContextFolder(contextFolder) {
    if (!contextFolder) return [];
    const sessions = this.app.sidebar?._allSessions || [];
    const hits = [];
    for (const s of sessions) {
      if (!s.cwd) continue;
      const cwdLast = s.cwd.replace(/\/+$/, '').split('/').pop();
      if (cwdLast === contextFolder) {
        const backend = s.backend || 'claude';
        const id = s.backendSessionId || s.sessionId;
        if (id) hits.push(`${backend}:${id}`);
      }
    }
    return hits;
  }

  // ── Borrow / restore (the heart of "Task Desktop owns task windows") ──

  _borrowTaskWindows() {
    const task = this.getActiveTask();
    if (!task) return;
    const allowed = this.getTaskSessionKeys(task);
    const wm = this.app.wm;
    const dm = this.app.desktopManager;
    if (!wm || !dm) return;

    for (const [winId, win] of wm.windows) {
      if (win.type !== 'chat' && win.type !== 'terminal') continue;
      const key = this._sessionKeyForWindow(winId, win);
      if (!key || !allowed.has(key)) continue;
      if (win._desktopId === TASK_DESKTOP_ID) continue; // already here
      win._origDesktopId = win._desktopId;
      win._desktopId = TASK_DESKTOP_ID;
      this._borrowedWinIds.add(winId);
      // Force-show: this window was hidden by the desktop switch a moment ago.
      if (win._hiddenByDesktop) {
        win._hiddenByDesktop = false;
        win.element.style.visibility = '';
        win.element.style.pointerEvents = '';
      }
    }
    wm._reflowWindows?.();
  }

  _restoreBorrowedWindows() {
    const wm = this.app.wm;
    if (!wm) return;
    for (const winId of this._borrowedWinIds) {
      const win = wm.windows.get(winId);
      if (!win) continue;
      if (typeof win._origDesktopId !== 'undefined') {
        win._desktopId = win._origDesktopId;
        delete win._origDesktopId;
      }
      // If we're leaving Task Desktop entirely, this window's true desktop
      // is not the current active one → hide it via the standard flag so
      // the next switchTo will reveal it correctly.
      const dm = this.app.desktopManager;
      if (dm && dm.activeDesktopId !== win._desktopId) {
        win._hiddenByDesktop = true;
        win.element.style.visibility = 'hidden';
        win.element.style.pointerEvents = 'none';
      }
    }
    this._borrowedWinIds.clear();
  }

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
    // Fall back to openSpec
    const spec = win._openSpec || {};
    const backendSessionId = spec.backendSessionId || spec.sessionId;
    const backend = spec.backend || 'claude';
    if (backendSessionId) return `${backend}:${backendSessionId}`;
    return null;
  }

  // ── Auto-resume / attach missing sessions ────────────────────

  _spawnMissingTaskSessions() {
    const task = this.getActiveTask();
    if (!task) return;
    const allowed = this.getTaskSessionKeys(task);
    if (allowed.size === 0) return;

    const allSess = this.app.sidebar?._allSessions || [];
    const wm = this.app.wm;
    if (!wm) return;

    // Build a set of sessionKeys that already have a window on Task Desktop.
    const haveWindow = new Set();
    for (const [winId, win] of wm.windows) {
      if (win._desktopId !== TASK_DESKTOP_ID) continue;
      const k = this._sessionKeyForWindow(winId, win);
      if (k) haveWindow.add(k);
    }

    for (const key of allowed) {
      if (haveWindow.has(key)) continue;
      const colon = key.indexOf(':');
      if (colon < 0) continue;
      const backend = key.slice(0, colon);
      const backendSessionId = key.slice(colon + 1);
      const sess = allSess.find(s =>
        (s.backendSessionId || s.sessionId) === backendSessionId &&
        (s.backend || 'claude') === backend);
      if (!sess) continue; // session not in sidebar (deleted file?) — skip

      const agentOpts = {
        backend,
        backendSessionId,
        agentKind: sess.agentKind || 'primary',
        agentRole: sess.agentRole || '',
        agentNickname: sess.agentNickname || '',
        sourceKind: sess.sourceKind || '',
        parentThreadId: sess.parentThreadId || null,
      };
      // Best effort — failures are silent so a single bad session doesn't
      // block the rest of the workspace from loading.
      try {
        if (sess.status === 'live' && sess.webuiId) {
          this.app.attachSession(sess.webuiId, sess.webuiName || sess.name, sess.cwd,
            { mode: sess.webuiMode || 'chat', ...agentOpts });
        } else if (sess.status === 'stopped') {
          this.app.resumeSession(sess.sessionId, sess.cwd, sess.name,
            { mode: 'chat', ...agentOpts });
        }
        // tmux / external sessions: skip — user has to attach those manually.
      } catch {}
    }
  }

  // ── Hook DesktopManager.switchTo to detect "leaving task desktop" ──

  _hookDesktopSwitch() {
    const dm = this.app.desktopManager;
    if (!dm) return;
    const orig = dm.switchTo.bind(dm);
    dm.switchTo = async (desktopId) => {
      // If switch is being driven by our own code, don't react to it.
      if (this._inProgrammaticSwitch) return orig(desktopId);
      // User clicked another desktop tab while a task was active → leave.
      if (this._activeTaskId && desktopId !== TASK_DESKTOP_ID) {
        this._restoreBorrowedWindows();
        this._activeTaskId = null;
        this._renderTopBar();
        // Sidebar re-render to clear the "active task" highlight.
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
    if (!task) {
      this._topBar.classList.remove('active');
      return;
    }
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

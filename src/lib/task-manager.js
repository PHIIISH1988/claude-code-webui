/**
 * TaskManager — owns the "currently active task workspace" state for the UI.
 *
 * Phase 3 of the task-centric refactor: clicking a task in the sidebar hides
 * every window whose underlying session is NOT associated with that task, so
 * Walter sees only the focused subset. Clicking "Back to Default" clears the
 * filter and reveals everything again.
 *
 * Design decisions worth remembering:
 *
 *   - Task workspace is a FILTER layer on top of the existing virtual-desktop
 *     model. Windows are not physically moved or duplicated; we toggle
 *     visibility:hidden via the same mechanism DesktopManager already uses.
 *
 *   - A window is visible iff !_hiddenByDesktop AND !_hiddenByTask AND
 *     !isMinimized. The two "hidden by …" flags compose, so the desktop
 *     and task layers stay independent and we don't have to refactor
 *     DesktopManager.
 *
 *   - Session→Task association comes from three sources, in order:
 *       1. task.sessions[]  (hand-written by Walter or by agents)
 *       2. task.extras[]    (webUI auto-managed)
 *       3. context_folder inference (sessions whose cwd ends with the task's
 *          context_folder). Used only when sessions[] is empty — the spec'd
 *          default behaviour from TASK-SCHEMA-V2.md.
 *
 *   - SyncStore exclusion: like task-focus, server skips broadcasting back
 *     to the originator. So set*() calls re-render locally too.
 *
 *   - We deliberately do NOT persist the active task across reloads in
 *     Phase 3 (always boot into Default). This is debatable but it avoids
 *     "Walter opens fresh tab and sees one task highlighted for reasons he
 *     forgot". If Walter pushes back we can flip it to SyncStore'd state.
 */

export class TaskManager {
  constructor(app) {
    this.app = app;
    /** @type {string | null}  null = Default Workspace */
    this._activeTaskId = null;
    /** @type {HTMLElement | null}  the top breadcrumb element */
    this._topBar = null;
    /** Listeners notified when the active task changes (sidebar uses this). */
    this._listeners = new Set();
  }

  // ── Public API ────────────────────────────────────────────────

  getActiveTaskId() { return this._activeTaskId; }
  getActiveTask() {
    if (!this._activeTaskId) return null;
    return this.app._taskById?.get(this._activeTaskId) || null;
  }

  /**
   * Activate a task workspace (or pass null/undefined to go back to Default).
   * Idempotent — calling with the current task is a no-op.
   */
  setActiveTask(taskId) {
    const next = taskId || null;
    if (this._activeTaskId === next) return;
    this._activeTaskId = next;
    this._applyFilter();
    this._renderTopBar();
    for (const fn of this._listeners) { try { fn(next); } catch {} }
  }

  clearActiveTask() { this.setActiveTask(null); }

  /** Re-evaluate visibility (called when task data, sessions, or windows change). */
  refresh() {
    if (this._activeTaskId) this._applyFilter();
    this._renderTopBar();
  }

  onActiveTaskChanged(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  // ── Association: which sessions belong to a task ─────────────

  /**
   * Compute the set of sessionKey strings (e.g. "claude:abc-123") that a
   * given task is associated with. Returns a Set for O(1) lookups during
   * window filtering.
   */
  getTaskSessionKeys(task) {
    if (!task) return new Set();
    const set = new Set();

    const declared = Array.isArray(task.sessions) ? task.sessions.filter(Boolean) : [];
    const extras = Array.isArray(task.extras) ? task.extras.filter(Boolean) : [];

    // Path 1: explicit declarations override inference
    if (declared.length > 0) {
      for (const k of declared) set.add(k);
    } else {
      // Path 2: context_folder inference (only when sessions[] is empty)
      const inferred = this._inferSessionKeysByContextFolder(task.context_folder);
      for (const k of inferred) set.add(k);
    }
    // Extras always merge in
    for (const k of extras) set.add(k);

    return set;
  }

  /** Find all session keys whose cwd matches the given context_folder name. */
  _inferSessionKeysByContextFolder(contextFolder) {
    if (!contextFolder) return [];
    const sessions = this.app.sidebar?._allSessions || [];
    const hits = [];
    for (const s of sessions) {
      if (!s.cwd) continue;
      // context_folder examples: `hr_contractor-management_260320`. The session
      // cwd is the full absolute path that *ends* with that folder name. We
      // use endsWith on a normalized path so we don't false-match a substring
      // in the middle of a different path.
      const cwdLast = s.cwd.replace(/\/+$/, '').split('/').pop();
      if (cwdLast === contextFolder) {
        const backend = s.backend || 'claude';
        const id = s.backendSessionId || s.sessionId;
        if (id) hits.push(`${backend}:${id}`);
      }
    }
    return hits;
  }

  // ── Visibility filter (the heart of Phase 3) ─────────────────

  _applyFilter() {
    const wm = this.app.wm;
    if (!wm) return;

    if (!this._activeTaskId) {
      // Default Workspace: clear all _hiddenByTask flags + restore visibility
      // (subject to other hide reasons like _hiddenByDesktop / isMinimized).
      for (const [, win] of wm.windows) {
        if (win._hiddenByTask) {
          win._hiddenByTask = false;
          this._applyWindowVisibility(win);
        }
      }
      return;
    }

    const task = this.getActiveTask();
    const allowedKeys = this.getTaskSessionKeys(task);

    for (const [winId, win] of wm.windows) {
      const allowed = this._isWindowAllowedInTask(winId, win, allowedKeys);
      if (allowed) {
        if (win._hiddenByTask) {
          win._hiddenByTask = false;
          this._applyWindowVisibility(win);
        }
      } else {
        if (!win._hiddenByTask) {
          win._hiddenByTask = true;
          this._applyWindowVisibility(win);
        }
      }
    }
  }

  /**
   * Resolve a window to its sessionKey and check if it's in the allowed set.
   * Non-chat / non-terminal windows (e.g. file explorer, editor) are always
   * allowed — they're not session-bound.
   */
  _isWindowAllowedInTask(winId, win, allowedKeys) {
    if (win.type !== 'chat' && win.type !== 'terminal') return true;

    const term = this.app.sessions?.get(winId);
    const allSess = this.app.sidebar?._allSessions || [];
    let match = null;
    if (term?.sessionId) {
      match = allSess.find(s => s.webuiId === term.sessionId);
    }
    if (!match) {
      // Fall back to openSpec — covers chat windows freshly opened, before
      // sidebar sync catches up.
      const spec = win._openSpec || {};
      const backendSessionId = spec.backendSessionId || spec.sessionId;
      const backend = spec.backend || 'claude';
      if (backendSessionId) {
        const key = `${backend}:${backendSessionId}`;
        return allowedKeys.has(key);
      }
      return true; // unknown — better to show than hide
    }
    const backend = match.backend || 'claude';
    const id = match.backendSessionId || match.sessionId;
    if (!id) return true;
    return allowedKeys.has(`${backend}:${id}`);
  }

  /**
   * Mirror of DesktopManager's per-window visibility logic, but accounts for
   * BOTH hidden flags. We can't reuse DesktopManager._applyWindowVisibility
   * because it doesn't know about _hiddenByTask.
   */
  _applyWindowVisibility(win) {
    const el = win.element;
    if (!el) return;
    const hidden = win._hiddenByDesktop || win._hiddenByTask;
    if (hidden) {
      el.style.visibility = 'hidden';
      el.style.pointerEvents = 'none';
    } else if (!win.isMinimized) {
      el.style.visibility = '';
      el.style.pointerEvents = '';
    }
  }

  // ── Top breadcrumb / "Back to Default" UI ────────────────────

  _renderTopBar() {
    // Find or lazy-create the top bar element. It lives inside the toolbar
    // so it stays sticky above the workspace without us having to touch
    // index.html. Removed entirely (display:none-equivalent) when no task
    // is active, so it costs nothing in Default mode.
    if (!this._topBar) {
      const toolbar = document.getElementById('toolbar');
      if (!toolbar) return;
      const bar = document.createElement('div');
      bar.className = 'task-active-bar';
      bar.innerHTML = `
        <span class="task-active-label">🎯</span>
        <span class="task-active-name"></span>
        <span class="task-active-status"></span>
        <button class="task-active-back" title="Back to Default Workspace">× Default</button>
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
    const nameEl = this._topBar.querySelector('.task-active-name');
    const statusEl = this._topBar.querySelector('.task-active-status');
    nameEl.textContent = task.title || task.id;
    nameEl.title = task.id + (task.title ? ` — ${task.title}` : '');
    const status = task.status || 'open';
    const priority = task.priority || 'normal';
    statusEl.textContent = `${status} · ${priority}`;
    statusEl.className = `task-active-status status-${status} priority-${priority}`;
  }
}

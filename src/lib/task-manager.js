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
import { lastTouchSignal } from './task-card.js';

const TASK_DESKTOP_ID = DesktopManager.TASK_DESKTOP_ID;

/**
 * Task workspace layout (Walter's spec 2026-06-06):
 *
 *   - Always 2 rows.
 *   - cols = max(2, ceil((N+1)/2)) where N = number of session windows.
 *     The +1 reserves a cell for the always-present Files window.
 *     This guarantees 2x2 minimum even for a single session.
 *   - Files window is pinned to the BOTTOM-LEFT cell, i.e. cell index
 *     = cols (row-major: row 1, col 0).
 *   - Sessions fill the remaining cells in order (0, 1, ..., cols-1,
 *     cols+1, ..., 2*cols-1). Empty cells are left blank when N+1 < 2*cols.
 *
 * Sizing examples:
 *   N=1: 2x2, sessions in [0],         Files in [2], empty [1,3]
 *   N=2: 2x2, sessions in [0,1],       Files in [2], empty [3]
 *   N=3: 2x2, sessions in [0,1,3],     Files in [2]
 *   N=4: 2x3, sessions in [0,1,2,4],   Files in [3], empty [5]
 *   N=5: 2x3, sessions in [0,1,2,4,5], Files in [3]
 *   N=6: 2x4, sessions in [0,1,2,3,5,6,7], Files in [4], empty [7] — wait
 *   ...
 *   N=7: 2x4, sessions fill all non-Files cells
 */
function taskGridSize(sessionCount) {
  const cols = Math.max(2, Math.ceil((sessionCount + 1) / 2));
  return { rows: 2, cols };
}

export class TaskManager {
  constructor(app) {
    this.app = app;
    this._activeTaskId = null;
    this._members = new Map();
    /** winId of the Files window pinned to bottom-left of task workspace. */
    this._filesWinId = null;
    /**
     * Defense-in-depth dedup for spawn calls. When we call
     * app.resumeSession(K) / app.attachSession(K) we add K here and clean
     * up either when the resulting window resolves to K (in _borrowTaskWindows)
     * or after a hard timeout (15 s). The race we're guarding against:
     *
     *   1. setActiveTask → spawn → resumeSession(K) is async
     *   2. webUI creates the chat window long before its
     *      openSpec.backendSessionId is filled in (or sessionId is wired)
     *   3. wm.onWindowsChanged fires → if we re-run spawn, the new window
     *      can't be matched to K yet, so spawn fires another resumeSession
     *   4. The loop produces N duplicate windows for the same session
     *
     * That bug is the immediate reason Walter saw 9 identical clones of
     * one Supermicro chat after clicking the task. The refresh/spawn
     * split below is the primary fix; _spawningKeys is the belt-and-
     * braces backup. */
    this._spawningKeys = new Map(); // key → setTimeout handle
    /**
     * Pending idle-close timers. Keyed by winId. When a task workspace
     * member becomes orphan (its session isn't in the new task's set)
     * and the session is currently IDLE (per isBusy()), we schedule a
     * 30-second close. While the timer is alive: limbo state stays as
     * usual. On fire: re-check busy; close only if still idle, else
     * re-schedule. Cancelled when the user returns to the task that
     * needs this session. Hard timeout configurable via setting
     * task.autoCloseIdleAfter (ms, 0 = never close).
     *
     * Walter explicitly required ZERO risk of killing in-flight work:
     * we use server-protocol-driven signals (streaming flag, active
     * background tasks, /goal state, pending permission, draft text)
     * and re-check at fire time, never relying on cached state.
     */
    this._pendingCloses = new Map(); // winId → timeoutHandle
    this._topBar = null;
    this._listeners = new Set();
    this._hookDesktopSwitch();
  }

  /** Derive the workspace folder for a task from its file path.
   *  task._path = `.../{ctx}/tasks/T-...md` → `.../{ctx}`.
   *  Used as the Files window's starting directory. Returns null when the
   *  task wasn't loaded with a path (rare). */
  _taskWorkspaceFolder(task) {
    if (!task?._path) return null;
    const m = task._path.match(/^(.*)\/tasks\/T-/);
    return m ? m[1] : null;
  }

  getActiveTaskId() { return this._activeTaskId; }
  getActiveTask() {
    if (!this._activeTaskId) return null;
    return this.app._taskById?.get(this._activeTaskId) || null;
  }
  onActiveTaskChanged(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  async setActiveTask(taskId) {
    // Serialize concurrent calls. setActiveTask is async (it awaits
    // dm.switchTo). If Walter clicks task A and then B before A's await
    // returns, both calls used to run their reconcile/borrow/spawn/layout
    // passes against the shared state concurrently — one call would set
    // window._desktopId to TASK while the other set it back to origin,
    // leaving the workspace blank ('white screen, toolbar gone' bug).
    //
    // Lock-and-queue: if a call is in flight, store the latest taskId in
    // _queuedTask and let the in-flight call pick it up when it finishes.
    // Intermediate clicks are dropped — only the latest taskId is honored,
    // which matches Walter's intent ('I clicked B last, take me to B').
    if (this._setActiveInFlight) {
      this._queuedTask = taskId;
      return;
    }
    this._setActiveInFlight = true;
    try {
      await this._setActiveTaskInner(taskId);
    } catch (e) {
      console.error('[TaskManager] setActiveTask threw — UI may be partial:', e);
      this._inProgrammaticSwitch = false;
    } finally {
      this._setActiveInFlight = false;
      if (Object.prototype.hasOwnProperty.call(this, '_queuedTask')) {
        const next = this._queuedTask;
        delete this._queuedTask;
        // Tail-call into ourselves to process the queued click.
        this.setActiveTask(next);
      }
    }
  }

  async _setActiveTaskInner(taskId) {
    const next = taskId || null;
    if (this._activeTaskId === next) return;

    const dm = this.app.desktopManager;
    if (!dm) return;

    if (!next) {
      this._teardownAllMembers();
      this._closeTaskFiles();
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
    this._ensureTaskFiles();
    this._scheduleAutoLayout();
    this._renderTopBar();
    this._notify();
  }

  clearActiveTask() { return this.setActiveTask(null); }

  /**
   * LIGHT refresh — reconcile + borrow + layout. NO spawn.
   *
   * Called from wm.onWindowsChanged whenever a window appears/disappears.
   * This MUST NOT call _spawnMissingTaskSessions: doing so caused a runaway
   * loop where every fresh resumeSession-created window triggered another
   * onWindowsChanged → refresh → spawn cycle before the window's session
   * key was wired up. Walter ended up with 9 duplicate clones of one chat.
   *
   * Spawn-missing only runs from explicit user actions (setActiveTask on
   * first entry, manualRefresh on same-task re-click), which fire once and
   * don't recurse.
   */
  refresh() {
    if (this._activeTaskId) {
      const r1 = this._reconcileMembersAgainstActiveTask();
      const r2 = this._borrowTaskWindows();
      this._ensureTaskFiles();
      // Only schedule layout when the visible window set actually changed.
      // Critical to break the loop: _applyAutoLayout's wm._notify call
      // triggers onWindowsChanged → refresh, and if refresh unconditionally
      // re-schedules layout we get an infinite redraw cycle that Walter
      // saw as 'windows shake into place forever'.
      if (r1 || r2) this._scheduleAutoLayout();
    }
    this._renderTopBar();
  }

  /**
   * USER-TRIGGERED refresh — full reconcile + borrow + spawn-missing + layout.
   * Bound to the sidebar "click already-active task" gesture so Walter can
   * say "bring back the sessions I just closed". Idempotent + dedup'd via
   * _spawningKeys, so rapid re-clicks don't multiply windows.
   */
  manualRefresh() {
    if (!this._activeTaskId) return;
    this._reconcileMembersAgainstActiveTask();
    this._borrowTaskWindows();
    this._spawnMissingTaskSessions();
    this._ensureTaskFiles();
    this._scheduleAutoLayout();
    this._renderTopBar();
  }

  // ── Session association ──────────────────────────────────────

  /**
   * Resolve a task to its allowed sessionKey set.
   *
   * Priority:
   *   1. Either task.sessions[] (agent-declared) OR task.extras[] (webUI-
   *      locked) present → use only those; inference SKIPPED. This is
   *      Walter's "lock" semantic: the moment he locks one session via
   *      right-click, inference stops second-guessing.
   *   2. Both empty → fall back to context_folder inference, capped at
   *      the single most-recently-started match.
   *
   * The first rule is critical: if extras only ADDED to inference, Walter
   * locking the 'correct' session would still leave the inferred 'wrong'
   * one visible alongside. The override matches his mental model — once
   * he's said "these are the sessions for this task", that's the truth.
   */
  getTaskSessionKeys(task) {
    if (!task) return new Set();
    const set = new Set();
    const declared = Array.isArray(task.sessions) ? task.sessions.filter(Boolean) : [];
    const extras = Array.isArray(task.extras) ? task.extras.filter(Boolean) : [];
    if (declared.length > 0 || extras.length > 0) {
      for (const k of declared) set.add(k);
      for (const k of extras) set.add(k);
    } else {
      const best = this._inferBestSessionByContextFolder(task.context_folder);
      if (best) set.add(best);
    }
    return set;
  }

  // ── Lock / unlock sessions to active task (Phase 3.5b) ──────

  /** Is the given sessionKey explicitly bound to the active task via
   *  task.sessions or task.extras? Used by the right-click menu to
   *  show "Lock" vs "Unlock" labels and by callers wanting to decide
   *  whether to ADD or REMOVE. */
  isSessionLockedToActiveTask(sessionKey) {
    const task = this.getActiveTask();
    if (!task || !sessionKey) return false;
    const declared = Array.isArray(task.sessions) ? task.sessions : [];
    const extras = Array.isArray(task.extras) ? task.extras : [];
    return declared.includes(sessionKey) || extras.includes(sessionKey);
  }

  async lockSessionToActiveTask(sessionKey) {
    const task = this.getActiveTask();
    if (!task || !sessionKey) return;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/extras`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey }),
      });
      if (!res.ok) throw new Error('lock failed: ' + res.status);
      // Optimistically update local cache so the next refresh sees the new
      // extras without waiting for the server's task-updated WS broadcast.
      task.extras = Array.isArray(task.extras) ? [...task.extras] : [];
      if (!task.extras.includes(sessionKey)) task.extras.push(sessionKey);
      // Re-evaluate the workspace: spawn the new session if not already
      // present, drop inferred ones that aren't in the lock list.
      this.manualRefresh();
    } catch (e) {
      console.warn('[TaskManager] lockSessionToActiveTask failed:', e);
    }
  }

  async unlockSessionFromActiveTask(sessionKey) {
    const task = this.getActiveTask();
    if (!task || !sessionKey) return;
    try {
      const res = await fetch(
        `/api/tasks/${encodeURIComponent(task.id)}/extras/${encodeURIComponent(sessionKey)}`,
        { method: 'DELETE' });
      if (!res.ok) throw new Error('unlock failed: ' + res.status);
      // Update local cache.
      if (Array.isArray(task.extras)) {
        task.extras = task.extras.filter(k => k !== sessionKey);
      }
      this.manualRefresh();
    } catch (e) {
      console.warn('[TaskManager] unlockSessionFromActiveTask failed:', e);
    }
  }

  _inferBestSessionByContextFolder(contextFolder) {
    if (!contextFolder) return null;
    // Exact string comparison. The lossy normalize workaround here was
    // reverted once we fixed the real bug — extractSessionMeta in
    // session-store.js used a 32 KB single-read that truncated big early
    // JSONL events (hook_success can be 50 KB+) and silently dropped the
    // cwd. Streaming chunks until found makes s.cwd accurate again.
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
      // startedAt is a NUMBER (mtime in ms), not an ISO string. Earlier
      // version called tb.localeCompare(ta) which crashed the entire async
      // setActiveTask chain — the click threw inside Promise and Walter saw
      // zero reaction.
      const ta = Number(a.startedAt) || 0;
      const tb = Number(b.startedAt) || 0;
      return tb - ta; // most recent first
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

    let changed = false;
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
      changed = true;
      // Window landed → release the spawn marker so a future explicit
      // refresh can spawn again if this window dies.
      this._clearSpawnMarker(key);
    }
    if (changed) wm._reflowWindows?.();
    return changed;
  }

  _markSpawning(key) {
    if (this._spawningKeys.has(key)) return;
    const t = setTimeout(() => this._spawningKeys.delete(key), 15000);
    this._spawningKeys.set(key, t);
  }
  _clearSpawnMarker(key) {
    const t = this._spawningKeys.get(key);
    if (t) { clearTimeout(t); this._spawningKeys.delete(key); }
  }

  _reconcileMembersAgainstActiveTask() {
    const task = this.getActiveTask();
    if (!task) return;
    const allowed = this.getTaskSessionKeys(task);
    const wm = this.app.wm;
    if (!wm) return;
    const dm = this.app.desktopManager;

    let changed = false;
    for (const [winId, meta] of [...this._members]) {
      const win = wm.windows.get(winId);
      if (!win) { this._members.delete(winId); this._cancelIdleClose(winId); changed = true; continue; }
      const key = this._sessionKeyForWindow(winId, win);
      const isMatch = key && allowed.has(key);

      if (isMatch) {
        const wasHidden = !!(win._hiddenByTask || win._hiddenByDesktop);
        meta.taskId = this._activeTaskId;
        this._show(win);
        if (wasHidden) changed = true;
        // Coming back into a task this session belongs to — cancel any
        // pending close so we don't kill it right after revealing it.
        this._cancelIdleClose(winId);
      } else {
        if (meta.borrowed) {
          win._desktopId = meta.origDesktopId || (dm?.desktops[0]?.id);
          this._hideByDesktop(win);
          this._members.delete(winId);
          this._cancelIdleClose(winId);
          changed = true;
        } else {
          const wasVisible = !win._hiddenByTask;
          this._hideByTask(win);
          this._scheduleIdleClose(winId);
          if (wasVisible) changed = true;
        }
      }
    }
    return changed;
  }

  // ── Idle-close lifecycle for orphaned auto-spawn members ─────

  /** Read configured idle window from settings; 0 disables the feature. */
  _idleCloseMs() {
    const s = this.app.settings?.get('task.autoCloseIdleAfter');
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return 30000;
    return n;
  }

  _scheduleIdleClose(winId) {
    if (this._pendingCloses.has(winId)) return; // already scheduled
    const ms = this._idleCloseMs();
    if (ms === 0) return; // user disabled auto-close entirely
    const t = setTimeout(() => this._maybeCloseIfIdle(winId), ms);
    this._pendingCloses.set(winId, t);
  }

  _cancelIdleClose(winId) {
    const t = this._pendingCloses.get(winId);
    if (t) { clearTimeout(t); this._pendingCloses.delete(winId); }
  }

  /**
   * Fired by the scheduled timer. Re-check the session's busy state at
   * the LAST possible moment, then either close or reschedule. This is
   * the load-bearing safety guarantee Walter required: we never close a
   * window because it was idle 30 s ago — only because it's idle RIGHT
   * NOW.
   */
  _maybeCloseIfIdle(winId) {
    this._pendingCloses.delete(winId);
    const wm = this.app.wm;
    const win = wm?.windows.get(winId);
    if (!win) {
      this._members.delete(winId);
      return;
    }
    // Only close orphaned auto-spawns. If the window became active
    // again (matched a re-clicked task) it was un-hidden by reconcile
    // and we should leave it alone.
    if (!win._hiddenByTask) {
      return;
    }
    const session = this.app.sessions?.get(winId);
    const busy = typeof session?.isBusy === 'function' ? session.isBusy() : true;
    if (busy) {
      // Still working. Schedule another check after the same idle window.
      this._scheduleIdleClose(winId);
      return;
    }
    // Safe to close. closeWindow goes through wm which honours the
    // user's closeBehavior setting (terminate kills the dtach session;
    // detach keeps it alive for later resume). For auto-spawned task
    // windows terminate is appropriate — _spawnMissingTaskSessions will
    // recreate them on next task entry.
    try { wm.closeWindow(winId); } catch (e) {
      console.warn('[TaskManager] idle close failed for', winId, e);
    }
    this._members.delete(winId);
  }

  _teardownAllMembers() {
    const wm = this.app.wm;
    const dm = this.app.desktopManager;
    if (!wm || !dm) return;
    // Cancel any pending idle close — Walter has left the task
    // workspace entirely, so any scheduled close needs to wait until he
    // returns and the orphan judgement gets re-done with fresh context.
    for (const winId of this._pendingCloses.keys()) this._cancelIdleClose(winId);
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
      // Defense-in-depth: if we've already kicked off a spawn for this key
      // and the window just hasn't materialised yet, do NOT fire another.
      // This is the actual fix for the 9-duplicate-clones bug Walter saw.
      // Primary fix is the refresh/manualRefresh split that keeps spawn off
      // the onWindowsChanged path, but this guard handles any other path
      // that might re-enter here while a resume is in flight.
      if (this._spawningKeys.has(key)) continue;
      let revived = false;
      for (const [winId, meta] of this._members) {
        const win = wm.windows.get(winId);
        if (!win || !win._hiddenByTask) continue;
        const k = this._sessionKeyForWindow(winId, win);
        if (k === key) {
          this._show(win);
          meta.taskId = this._activeTaskId;
          // Reviving a limbo'd window for a re-entered task — cancel its
          // pending close so we don't kill it shortly after revealing it.
          this._cancelIdleClose(winId);
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
      this._markSpawning(key);
      try {
        if (sess.status === 'live' && sess.webuiId) {
          this.app.attachSession(sess.webuiId, sess.webuiName || sess.name, sess.cwd,
            { mode: sess.webuiMode || 'chat', ...agentOpts });
        } else if (sess.status === 'stopped') {
          this.app.resumeSession(sess.sessionId, sess.cwd, sess.name,
            { mode: 'chat', ...agentOpts });
        } else {
          // Status we don't auto-handle (tmux/external) — release the
          // marker so we don't block future explicit retries.
          this._clearSpawnMarker(key);
        }
      } catch (e) {
        console.warn('[TaskManager] spawn threw:', e);
        this._clearSpawnMarker(key);
      }
    }
  }

  // ── Files window (always pinned to bottom-left) ──────────────

  _ensureTaskFiles() {
    const task = this.getActiveTask();
    if (!task) return;
    const folder = this._taskWorkspaceFolder(task);
    if (!folder) return;
    const wm = this.app.wm;
    if (!wm) return;

    // Reuse the existing Files window if we have one.
    if (this._filesWinId) {
      const win = wm.windows.get(this._filesWinId);
      if (win && win._explorer) {
        // Only navigate the Files window to the task folder when the ACTIVE
        // TASK CHANGED (or on first home). Walter reported being locked into
        // the task folder: the old code re-navigated on every refresh, so
        // browsing to Downloads to drag a file got yanked back instantly.
        // Within the same task we leave his navigation alone.
        if (this._filesHomedTaskId !== this._activeTaskId
            && win._explorer.currentPath !== folder) {
          try { win._explorer.navigate(folder); } catch {}
        }
        this._filesHomedTaskId = this._activeTaskId;
        // Make sure it's on Task Desktop and visible.
        if (win._desktopId !== TASK_DESKTOP_ID) win._desktopId = TASK_DESKTOP_ID;
        this._show(win);
        return;
      }
      // Window was closed externally — fall through and recreate.
      this._filesWinId = null;
    }

    const winInfo = this.app.openFileExplorer(folder);
    if (!winInfo) return;
    winInfo._desktopId = TASK_DESKTOP_ID;
    winInfo._taskFilesPin = true; // marker — never auto-borrowed/restored
    this._filesWinId = winInfo.id;
    this._filesHomedTaskId = this._activeTaskId;
  }

  _closeTaskFiles() {
    if (!this._filesWinId) return;
    const wm = this.app.wm;
    const win = wm?.windows.get(this._filesWinId);
    if (win) {
      try { wm.closeWindow(this._filesWinId); } catch {}
    }
    this._filesWinId = null;
  }

  // ── Layout ───────────────────────────────────────────────────

  /**
   * Debounced layout scheduler. Collapses rapid calls into ONE layout
   * pass 300 ms after the last schedule, which is essential because:
   *
   *   - setActiveTask schedules a layout, then each of the 3 spawned
   *     chat windows triggers wm.onWindowsChanged → refresh → another
   *     schedule, plus the old code fired the layout TWICE per schedule
   *     (rAF + 1500 ms). That stacked to ~6-8 layouts per task entry
   *     with overlapping 220 ms position animations, which Walter saw
   *     as 'windows shake into place ~once per second'.
   *
   *   - _applyAutoLayout calls wm._notify() at the end (so layoutManager
   *     debounces an autosave). _notify also runs onWindowsChanged →
   *     refresh, which previously always re-scheduled layout. That's a
   *     self-perpetuating loop. The fix here (debounce) + the change
   *     to refresh() (skip _scheduleAutoLayout when nothing changed)
   *     together break the loop.
   */
  _scheduleAutoLayout() {
    if (this._layoutTimer) clearTimeout(this._layoutTimer);
    this._layoutTimer = setTimeout(() => {
      this._layoutTimer = null;
      this._applyAutoLayout();
    }, 300);
  }

  _applyAutoLayout() {
    const wm = this.app.wm;
    const dm = this.app.desktopManager;
    if (!wm || !dm) return;
    if (dm.activeDesktopId !== TASK_DESKTOP_ID) return;

    // Partition visible windows into sessions vs Files.
    const all = [...wm.windows.values()].filter(w =>
      !w.isMinimized && !w._hiddenByDesktop && !w._hiddenByTask
      && w._desktopId === TASK_DESKTOP_ID
      && !(w._tabChain && w._tabChain.tabs[0] !== w.id));
    const sessions = all.filter(w => w.type === 'chat' || w.type === 'terminal');
    const filesWin = all.find(w => w.id === this._filesWinId && w.type === 'files');

    if (sessions.length === 0 && !filesWin) return;

    const { rows, cols } = taskGridSize(sessions.length);
    wm.setGrid(rows, cols);
    const totalCells = rows * cols;
    const filesCellIdx = cols; // bottom-left = row 1, col 0

    // Place Files first so it claims its cell. If for any reason Files
    // isn't present, sessions cascade through the bottom-left cell as
    // well rather than leaving an awkward hole.
    if (filesWin) {
      wm._positionToCell(filesWin, filesCellIdx, true);
      setTimeout(() => wm._captureGridBounds(filesWin), 250);
    }

    let cellIdx = 0;
    for (const sess of sessions) {
      if (filesWin && cellIdx === filesCellIdx) cellIdx++;
      if (cellIdx >= totalCells) break;
      wm._positionToCell(sess, cellIdx, true);
      const w = sess;
      setTimeout(() => {
        wm._captureGridBounds(w);
        if (w._tabChain) wm._syncChainBounds(w._tabChain);
      }, 250);
      cellIdx++;
    }
    setTimeout(() => { wm._scheduleOverlapUpdate?.(); wm._notify?.(); }, 300);
  }

  // ── Visibility helpers ───────────────────────────────────────

  _show(win) {
    if (!win?.element) return;
    if (win._hiddenByTask) win._hiddenByTask = false;
    if (win._hiddenByDesktop) win._hiddenByDesktop = false;
    win.element.style.visibility = '';
    win.element.style.pointerEvents = '';
  }
  _hideByDesktop(win) {
    if (!win?.element) return;
    win._hiddenByDesktop = true;
    win.element.style.visibility = 'hidden';
    win.element.style.pointerEvents = 'none';
  }
  _hideByTask(win) {
    if (!win?.element) return;
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
        <span class="task-active-touched"></span>
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

    // Last-touched indicator in the top bar — reuses the same lastTouchSignal
    // helper as the sidebar cards so the staleness story is consistent.
    const touchEl = this._topBar.querySelector('.task-active-touched');
    const sig = lastTouchSignal(task);
    if (sig) {
      touchEl.textContent = `last touched ${sig.label}`;
      touchEl.title = `${sig.source} · ${sig.iso}`;
      touchEl.className = `task-active-touched task-touched ${sig.tierClass}`;
    } else {
      touchEl.textContent = '';
      touchEl.className = 'task-active-touched';
    }
  }

  _notify() {
    for (const fn of this._listeners) { try { fn(this._activeTaskId); } catch {} }
  }
}

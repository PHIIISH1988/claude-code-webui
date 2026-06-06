/**
 * TaskStore — claude-ops task system integration for webUI.
 *
 * Responsibilities:
 *   1. Discover all task files under {workspacesDir}/{ws}/{ctx}/tasks/
 *      - Light task: tasks/T-yymmdd-{slug}.md  (single file)
 *      - Heavy task: tasks/T-yymmdd-{slug}/TASK.md  (folder + index)
 *      - Skip files under _archive/ (filesystem-level archive)
 *   2. Parse YAML frontmatter, expose tasks as in-memory map (taskId → fields).
 *   3. Watch filesystem (chokidar) for add/change/unlink, emit events.
 *   4. Allow controlled writes back to frontmatter:
 *      - Whitelist of webUI-writable fields (status / priority / sessions /
 *        extras / has_workspace / archived_at / updated). Hand-written fields
 *        (id / title / owner / part_of / markdown body / etc.) are never touched.
 *      - Atomic write (tmp + rename) to avoid partial writes.
 *      - Per-file write serialization to avoid lost-update races.
 *      - Git commit with author `webui-auto <noreply@webui-auto>` so the
 *        change is auditable + revertable without polluting Walter's identity.
 *
 * Events emitted:
 *   - 'task-updated' { taskId, task, old }   when a task is loaded or changed
 *   - 'task-deleted' { taskId }              when a task file is removed/renamed away
 *
 * Compatibility notes:
 *   - If `workspacesDir` does not exist on disk, TaskStore.init() returns early.
 *     This makes the webUI usable on machines without a claude-ops checkout.
 *   - Frontmatter that fails to parse leaves the task in the map with
 *     `_parseError` set; the UI can surface this without crashing.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const YAML = require('yaml');
const chokidar = require('chokidar');

/**
 * Why the `yaml` package and not `js-yaml`:
 *
 * webUI must edit a tiny subset of fields without disturbing Walter's
 * hand-written content. js-yaml does parse → JS object → dump, which loses:
 *   - timezone offsets in timestamps (e.g. `-07:00` → `Z`),
 *   - flow vs block style for arrays (e.g. `tags: [test]` → block list),
 *   - key ordering, indentation, comments.
 *
 * The `yaml` package's Document API lets us surgically update single keys
 * in place: untouched fields render byte-identical to the input.
 */

const ARCHIVE_FOLDER = '_archive';
const TASK_FILENAME_RE = /^T-\d{6}-[a-z0-9][a-z0-9-]*\.md$/;
const TASK_FOLDER_RE = /^T-\d{6}-[a-z0-9][a-z0-9-]*$/;

// Fields the webUI is allowed to write. Anything else is rejected.
const WRITABLE_FIELDS = new Set([
  'status', 'priority', 'sessions', 'extras',
  'has_workspace', 'archived_at', 'updated',
]);

class TaskStore extends EventEmitter {
  constructor({ workspacesDir, gitAuthor } = {}) {
    super();
    this.workspacesDir = workspacesDir
      || process.env.CLAUDE_OPS_WORKSPACES
      || path.join(os.homedir(), 'Documents', 'claude-ops', 'workspaces');
    this.gitAuthor = gitAuthor || {
      name: 'webui-auto',
      email: 'noreply@webui-auto',
    };

    /** @type {Map<string, object>} taskId → parsed task object */
    this.tasks = new Map();
    /** @type {Map<string, Promise>} per-file write serialization */
    this._writeQueue = new Map();
    this.watcher = null;
    this._inited = false;
  }

  async init() {
    if (this._inited) return;
    this._inited = true;

    let exists = false;
    try {
      const st = await fs.promises.stat(this.workspacesDir);
      exists = st.isDirectory();
    } catch {}
    if (!exists) {
      // No claude-ops checkout — silently skip. webUI still works for everything else.
      return;
    }

    await this._discoverAll();
    this._setupWatcher();
  }

  // ── Discovery ────────────────────────────────────────────────

  async _discoverAll() {
    const files = await this._findTaskFiles(this.workspacesDir);
    for (const fp of files) {
      try {
        await this._loadFile(fp, /* silent */ true);
      } catch (e) {
        // ignore — _loadFile records parse errors on the task object
      }
    }
  }

  async _findTaskFiles(root) {
    const results = [];
    const visit = async (dir, depth) => {
      if (depth > 12) return; // safety vs symlink loops
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.name === ARCHIVE_FOLDER) continue;
        const fp = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          await visit(fp, depth + 1);
        } else if (e.isFile() && this._isTaskFile(fp)) {
          results.push(fp);
        }
      }
    };
    await visit(root, 0);
    return results;
  }

  _isTaskFile(fp) {
    const base = path.basename(fp);
    const parent = path.basename(path.dirname(fp));
    // light task: .../tasks/T-yymmdd-slug.md
    if (parent === 'tasks' && TASK_FILENAME_RE.test(base)) return true;
    // heavy task: .../tasks/T-yymmdd-slug/TASK.md
    if (base === 'TASK.md' && TASK_FOLDER_RE.test(parent)) {
      const grand = path.basename(path.dirname(path.dirname(fp)));
      return grand === 'tasks';
    }
    return false;
  }

  _extractTaskId(fp) {
    const base = path.basename(fp);
    const parent = path.basename(path.dirname(fp));
    if (parent === 'tasks' && TASK_FILENAME_RE.test(base)) {
      return base.replace(/\.md$/, '');
    }
    if (base === 'TASK.md' && TASK_FOLDER_RE.test(parent)) return parent;
    return null;
  }

  // ── Parse / Load ─────────────────────────────────────────────

  _parseFrontmatter(content) {
    // Standard frontmatter: ---\n<yaml>\n---\n<body>
    const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { frontmatter: {}, fmText: '', body: content, hadFrontmatter: false };
    let frontmatter = {};
    try {
      frontmatter = YAML.parse(m[1]) || {};
      if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
        throw new Error('frontmatter is not an object');
      }
    } catch (e) {
      const err = new Error(`YAML parse: ${e.message}`);
      err.cause = e;
      throw err;
    }
    return { frontmatter, fmText: m[1], body: m[2], hadFrontmatter: true };
  }

  async _loadFile(fp, silent = false) {
    const taskId = this._extractTaskId(fp);
    if (!taskId) return null;

    let frontmatter = {};
    let body = '';
    let parseError = null;
    try {
      const content = await fs.promises.readFile(fp, 'utf-8');
      const parsed = this._parseFrontmatter(content);
      frontmatter = parsed.frontmatter;
      body = parsed.body;
    } catch (e) {
      parseError = String(e.message || e);
    }

    const task = {
      ...frontmatter,
      id: frontmatter.id || taskId,
      _path: fp,
      _body: body,
      _parseError: parseError || undefined,
    };
    // strip undefined to keep payload clean
    if (task._parseError === undefined) delete task._parseError;

    const old = this.tasks.get(taskId);
    this.tasks.set(taskId, task);

    if (!silent) {
      // Only emit if something visibly changed
      if (!old || !shallowFrontmatterEqual(old, task)) {
        this.emit('task-updated', { taskId, task, old });
      }
    }
    return task;
  }

  // ── Watcher ──────────────────────────────────────────────────

  _setupWatcher() {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.workspacesDir, {
      ignored: (p) => {
        if (p.includes(`${path.sep}_archive${path.sep}`)) return true;
        if (p.includes(`${path.sep}.git${path.sep}`)) return true;
        if (p.includes(`${path.sep}node_modules${path.sep}`)) return true;
        return false;
      },
      persistent: true,
      ignoreInitial: true,
      depth: 12,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });

    this.watcher.on('add', (fp) => {
      if (this._isTaskFile(fp)) this._loadFile(fp).catch(() => {});
    });
    this.watcher.on('change', (fp) => {
      if (this._isTaskFile(fp)) this._loadFile(fp).catch(() => {});
    });
    this.watcher.on('unlink', (fp) => {
      const taskId = this._extractTaskId(fp);
      if (taskId && this.tasks.has(taskId)) {
        this.tasks.delete(taskId);
        this.emit('task-deleted', { taskId });
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────

  list() { return Array.from(this.tasks.values()); }

  get(taskId) { return this.tasks.get(taskId) || null; }

  /**
   * Update a task's frontmatter with the given fields. Only WRITABLE_FIELDS
   * may be passed; anything else throws. The `updated` field is bumped
   * automatically. Returns { ok: true, changes: [...] } on success or
   * { ok: true, noop: true } if nothing changed.
   */
  async update(taskId, changes) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!task._path) throw new Error(`Task has no path: ${taskId}`);

    const safe = {};
    for (const [k, v] of Object.entries(changes || {})) {
      if (!WRITABLE_FIELDS.has(k)) {
        throw new Error(`Field not writable by webUI: ${k}`);
      }
      safe[k] = v;
    }
    if (Object.keys(safe).length === 0) {
      return { ok: true, noop: true };
    }
    safe.updated = new Date().toISOString();
    return this._enqueueWrite(task._path, taskId, safe);
  }

  // Add a session to the `extras` list (idempotent).
  async addExtra(taskId, sessionKey) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const cur = Array.isArray(task.extras) ? task.extras.slice() : [];
    if (cur.includes(sessionKey)) return { ok: true, noop: true };
    cur.push(sessionKey);
    return this.update(taskId, { extras: cur });
  }

  // Remove a session from `extras` (idempotent). Will NOT touch the `sessions`
  // list (those are owner-declared, only Walter/agent edits them by hand).
  async removeExtra(taskId, sessionKey) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const cur = Array.isArray(task.extras) ? task.extras : [];
    const next = cur.filter(k => k !== sessionKey);
    if (next.length === cur.length) return { ok: true, noop: true };
    return this.update(taskId, { extras: next });
  }

  // ── Write pipeline (serialized per file) ──────────────────────

  _enqueueWrite(fp, taskId, changes) {
    const prev = this._writeQueue.get(fp) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this._writeFrontmatter(fp, taskId, changes));
    this._writeQueue.set(fp, next.catch(() => {}));
    return next;
  }

  async _writeFrontmatter(fp, taskId, changes) {
    const original = await fs.promises.readFile(fp, 'utf-8');
    const parsed = this._parseFrontmatter(original);
    if (!parsed.hadFrontmatter) {
      throw new Error(`Cannot write: ${fp} has no frontmatter block`);
    }
    const fm = parsed.frontmatter;

    // Detect actual changes (skip the write entirely if nothing differs)
    const changeSummary = [];
    for (const [k, v] of Object.entries(changes)) {
      if (k === 'updated') continue; // updated bump is implicit, not user-visible
      if (!deepEqual(fm[k], v)) {
        changeSummary.push(`${k}: ${fmtVal(fm[k])} → ${fmtVal(v)}`);
      }
    }
    if (changeSummary.length === 0) {
      // Only `updated` changed — not interesting enough to commit
      return { ok: true, noop: true };
    }

    // Surgical edit via Document AST: untouched fields are byte-identical.
    const doc = YAML.parseDocument(parsed.fmText);
    for (const [k, v] of Object.entries(changes)) {
      doc.set(k, v);
    }
    let newFmText = String(doc);
    // YAML.Document.toString() guarantees a trailing newline; strip one so the
    // outer `---\n${fmText}---` template doesn't produce a blank line.
    if (newFmText.endsWith('\n')) newFmText = newFmText.slice(0, -1);
    const newContent = `---\n${newFmText}\n---\n${parsed.body}`;

    // Atomic write
    const tmp = `${fp}.webui-tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmp, newContent, 'utf-8');
    await fs.promises.rename(tmp, fp);

    // Reload our cache from disk (will emit 'task-updated')
    await this._loadFile(fp);

    // Git commit (best-effort: failure does NOT roll back the file write)
    const msg = `webui: ${taskId} ${changeSummary.join('; ')}`;
    let commitResult = null;
    try {
      commitResult = await this._gitCommit(fp, msg);
    } catch (e) {
      commitResult = { error: String(e.message || e) };
    }

    return { ok: true, changes: changeSummary, message: msg, commit: commitResult };
  }

  // ── Git ──────────────────────────────────────────────────────

  async _findGitRoot(fp) {
    let dir = path.dirname(fp);
    while (dir && dir !== '/' && dir !== path.dirname(dir)) {
      try {
        await fs.promises.access(path.join(dir, '.git'));
        return dir;
      } catch {}
      dir = path.dirname(dir);
    }
    return null;
  }

  async _gitCommit(fp, message) {
    const repoDir = await this._findGitRoot(fp);
    if (!repoDir) return { skipped: 'not in git repo' };

    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: this.gitAuthor.name,
      GIT_AUTHOR_EMAIL: this.gitAuthor.email,
      GIT_COMMITTER_NAME: this.gitAuthor.name,
      GIT_COMMITTER_EMAIL: this.gitAuthor.email,
    };

    // Stage only the specific file
    await execFileP('git', ['add', '--', fp], { cwd: repoDir, env });
    try {
      const { stdout } = await execFileP(
        'git',
        ['commit', '-m', message, '--only', '--', fp],
        { cwd: repoDir, env }
      );
      // Extract short hash from output (line like "[branch abcd123] msg")
      const hashMatch = stdout.match(/\[\S+ ([0-9a-f]+)\]/);
      return { committed: true, hash: hashMatch ? hashMatch[1] : null, message };
    } catch (e) {
      const out = `${e.stderr || ''}${e.stdout || ''}`;
      if (/nothing to commit/i.test(out)) {
        // Race / no real diff — fine
        return { committed: false, reason: 'nothing-to-commit' };
      }
      throw new Error(`git commit failed: ${out || e.message}`);
    }
  }

  // ── Teardown ─────────────────────────────────────────────────

  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.removeAllListeners();
  }
}

// ── helpers ────────────────────────────────────────────────────

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

function fmtVal(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function shallowFrontmatterEqual(a, b) {
  // Compare excluding webUI-internal fields (those start with '_')
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(k => !k.startsWith('_')));
  for (const k of keys) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

module.exports = { TaskStore, WRITABLE_FIELDS };

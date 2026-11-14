import fs from 'node:fs';
import path from 'node:path';

/**
 * One writer at a time per log directory, across processes.
 *
 * Every process that appends to a log takes this lock first: `vw hook`, which
 * Claude Code runs once per tool call and in parallel for parallel calls, and
 * `ProofLog`, which `vw proxy` and the library's Recorder write through. Two
 * proxies wrapping two MCP servers in one project write one log, and so do a
 * proxy and a coding agent's hooks. Without the lock each appends the next
 * sequence number it remembers, and the log ends up with two entry 5s and a
 * broken chain: a log that reports tampering when nobody touched it.
 *
 * The file keeps the name `vw hook` gave it, so hooks and proxies of this
 * version contend for the same lock.
 */
const LOCK = 'hook.lock';

/**
 * Locks this process holds, by lock file, with how deeply. A writer that
 * already holds a log's lock and calls something that takes it again (the
 * hook opening a log, then appending) carries on rather than waiting on
 * itself.
 *
 * @type {Map<string, number>}
 */
const held = new Map();

/** @param {string} file @returns {string | null} */
function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Whether the process a lock file names is still running. A lock that is gone,
 * or not yet written, is treated as held: the next attempt settles it.
 *
 * @param {string | null} text
 */
function holderAlive(text) {
  const pid = Number(text);
  if (text === null || !Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists and belongs to someone else.
    return /** @type {NodeJS.ErrnoException} */ (e).code !== 'ESRCH';
  }
}

/** How long a dead holder's lock must sit unchanged before it is taken over. */
const ABANDONED_MS = 1000;

/**
 * Whether the lock still names `holder`, a process that has exited, and has
 * not been touched for a while.
 *
 * "Its holder is dead" alone is not enough. Reading the holder and removing
 * the file are two steps: in between, that holder can release the lock and
 * exit, and a third writer take it. Removing the file then removes a live
 * lock, two writers append at once, and a receipt is lost. That was seen as
 * seven receipts from eight parallel calls. A lock taken a moment ago is
 * fresh, so it is never mistaken for one a crash left behind.
 *
 * @param {string} file
 * @param {string | null} holder
 */
function abandoned(file, holder) {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < ABANDONED_MS) return false;
    return readIfPresent(file) === holder;
  } catch {
    return false;
  }
}

/**
 * Whether a failure to create the lock file means "someone else has it, try
 * again" rather than a real error.
 *
 * On Windows, a file deleted while another process still has it open stays
 * "delete pending" until that handle closes, and creating the same name in
 * that window fails with EPERM or EACCES, not EEXIST. A writer releasing the
 * lock while a waiting one reads it to see who holds it is exactly that, and
 * treating it as fatal lost a parallel tool call's receipt.
 *
 * @param {string | undefined} code
 * @param {string} [platform]
 */
export function lockIsBusy(code, platform = process.platform) {
  if (code === 'EEXIST') return true;
  return platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
}

/**
 * Run `fn` holding the log directory's writer lock: one writer at a time.
 * Reentrant within a process. Waits up to VOUCHWELL_LOCK_WAIT_MS (or the
 * older VOUCHWELL_HOOK_LOCK_WAIT_MS), 15 seconds by default.
 *
 * @template T
 * @param {string} dir
 * @param {() => T} fn
 * @param {{ platform?: string }} [opts]  For tests.
 * @returns {T}
 */
export function withLock(dir, fn, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.resolve(dir, LOCK);
  const depth = held.get(file) ?? 0;
  if (depth > 0) {
    held.set(file, depth + 1);
    try {
      return fn();
    } finally {
      held.set(file, depth);
    }
  }

  const waitMs = Number(process.env.VOUCHWELL_LOCK_WAIT_MS ?? process.env.VOUCHWELL_HOOK_LOCK_WAIT_MS) || 15_000;
  const deadline = Date.now() + waitMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (!lockIsBusy(code, opts.platform)) throw e;
      // A writer that died holding the lock must not stop every later one.
      // The lock names its holder, so a dead holder's lock is taken over.
      if (code === 'EEXIST') {
        const holder = readIfPresent(file);
        if (!holderAlive(holder) && abandoned(file, holder)) fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 20 });
      }
      if (Date.now() > deadline) throw new Error(`the log at ${dir} stayed locked for ${waitMs / 1000}s (last: ${code})`);
      Atomics.wait(nap, 0, 0, 20);
    }
  }
  held.set(file, 1);
  try {
    return fn();
  } finally {
    held.delete(file);
    // Retried, for the same Windows reason: a reader can be holding it.
    fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 20 });
  }
}

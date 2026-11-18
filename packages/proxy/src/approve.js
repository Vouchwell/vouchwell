import fs from 'node:fs';
import { createInterface } from 'node:readline';
import tty from 'node:tty';

/**
 * Human-in-the-loop approval for actions the policy escalates.
 *
 * The contract every approver here honours: **an escalation that cannot be
 * resolved is a denial.** Timeouts, a missing terminal, an unreachable webhook,
 * a malformed reply — all resolve to `deny`. The alternative is a system that
 * quietly degrades into "allow everything" exactly when it is under stress,
 * which is when the guardrail was supposed to matter most.
 */

/**
 * @typedef {object} ApprovalRequest
 * @property {string} target
 * @property {unknown} params      Already redacted — an approver sees a preview, not secrets.
 * @property {string} reason
 * @property {string[]} rules
 * @property {import('@vouchwell/core').Actor} actor
 */

/**
 * @typedef {object} ApprovalOutcome
 * @property {boolean} approved
 * @property {string} by
 * @property {string} [note]
 */

/**
 * Never approves. The default, and the right default: a team that has not yet
 * wired up an approver should find escalated actions blocked, not waved
 * through.
 *
 * @returns {(req: ApprovalRequest) => Promise<ApprovalOutcome>}
 */
export function denyingApprover() {
  return async () => ({
    approved: false,
    by: 'policy:no-approver',
    note: 'the policy escalated this action and no approver is configured',
  });
}

/**
 * A string made safe to show at the prompt: control characters as escapes.
 * The tool name comes from the tool server, and an escape sequence in it
 * could repaint the prompt so a person approves something other than what
 * they read.
 *
 * @param {unknown} s
 */
export function plain(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Ask a human at the terminal.
 *
 * Reads from the controlling TTY rather than stdin, because stdin is the MCP
 * channel and is already spoken for. Without a TTY — CI, a daemon — this
 * denies rather than hanging forever.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=120000]
 * @param {string} [opts.by='tty']
 * @param {() => { input: NodeJS.ReadableStream & { destroy(): void }, output: NodeJS.WritableStream }} [opts.open]
 *   Where to ask: the controlling terminal unless given, for tests and for
 *   embedders with a terminal of their own.
 * @returns {(req: ApprovalRequest) => Promise<ApprovalOutcome>}
 */
export function ttyApprover(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const by = opts.by ?? 'tty';
  const open = opts.open ?? openTerminal;

  // One question at a time. Each escalation used to open the terminal and
  // read it on its own, so two at once printed two prompts and raced for the
  // next line typed: a "y" meant for one could approve the other.
  let queue = Promise.resolve();
  return (req) => {
    const turn = queue.then(() => ask(req));
    queue = turn.then(() => undefined, () => undefined);
    return turn;
  };

  /** @param {ApprovalRequest} req @returns {Promise<ApprovalOutcome>} */
  async function ask(req) {
    let io;
    try {
      io = open();
    } catch {
      return {
        approved: false,
        by: 'policy:no-tty',
        note: 'escalation needed a human but no terminal is attached',
      };
    }
    const { input, output } = io;

    output.write('\n');
    output.write('  ┌─ Vouchwell: approval required ' + '─'.repeat(28) + '\n');
    output.write(`  │ tool     ${plain(req.target)}\n`);
    output.write(`  │ for      ${plain(req.actor.principal)}\n`);
    output.write(`  │ reason   ${plain(req.reason)}\n`);
    output.write(`  │ rules    ${plain(req.rules.join(', ')) || '—'}\n`);
    const preview = plain(JSON.stringify(req.params));
    output.write(`  │ args     ${preview.length > 160 ? preview.slice(0, 157) + '…' : preview}\n`);
    output.write('  └' + '─'.repeat(58) + '\n');

    const rl = createInterface({ input, terminal: false });
    let answer;
    try {
      answer = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        output.write(`  Approve? [y/N] (${Math.round(timeoutMs / 1000)}s) `);
        rl.once('line', (line) => {
          clearTimeout(timer);
          resolve(line.trim().toLowerCase());
        });
      });
    } finally {
      rl.close();
      // Closing the interface leaves the stream reading the terminal. After a
      // timeout that reader stayed, and took the next line typed for anything
      // else, including the next prompt's answer.
      input.destroy();
      output.write('\n');
      output.end();
    }

    if (answer === null) {
      return { approved: false, by: 'policy:timeout', note: 'no answer before the deadline' };
    }
    const approved = answer === 'y' || answer === 'yes';
    return { approved, by, note: approved ? 'approved at the terminal' : 'declined at the terminal' };
  }
}

/**
 * The controlling terminal, for reading an answer and writing the question.
 * Not stdin and stdout: those are the MCP channel.
 *
 * @returns {{ input: NodeJS.ReadableStream & { destroy(): void }, output: NodeJS.WritableStream }}
 */
function openTerminal() {
  if (process.platform === 'win32') {
    // Two devices on Windows: the console's input, and its screen. Both are
    // opened for reading and writing. A terminal handle reads the console's
    // mode and the screen's size, which needs read access (opened for writing
    // only, the screen is not even seen as a console), and libuv stops a read
    // waiting on the input by putting an Enter keypress into it.
    const inFd = fs.openSync('\\\\.\\CONIN$', 'r+');
    let outFd;
    try {
      outFd = fs.openSync('\\\\.\\CONOUT$', 'r+');
    } catch (err) {
      fs.closeSync(inFd);
      throw err;
    }
    return consoleStreams(inFd, outFd);
  }
  // One device elsewhere, opened once for both directions.
  return terminalStreams(fs.openSync('/dev/tty', 'r+'));
}

/**
 * A stream to read and a stream to write over one open descriptor, such as a
 * terminal opened for both: what `ttyApprover`'s `open` returns. The streams
 * take the descriptor over, and it is closed when both are done.
 *
 * A terminal is read the way `process.stdin` reads one, through a terminal
 * handle that stops when destroyed. A file stream reads in a worker thread
 * that nothing interrupts: destroyed after an answer, it went on waiting,
 * took the next line typed (the next prompt's answer), and kept `vw proxy`
 * from exiting after its server had.
 *
 * Anything else gets two fs streams that close the descriptor once, in
 * whichever order they finish. Two plain fs streams cannot share one: each
 * closes it when destroyed, `autoClose: false` or not, and the other's next
 * write fails with EBADF.
 *
 * @param {number} fd  Open for reading and writing.
 * @returns {{ input: NodeJS.ReadableStream & { destroy(): void }, output: NodeJS.WritableStream }}
 */
export function terminalStreams(fd) {
  if (tty.isatty(fd)) return terminalHandles(fd);
  let users = 2;
  /** @param {number} _fd @param {(err?: NodeJS.ErrnoException | null) => void} done */
  const close = (_fd, done) => (--users === 0 ? fs.close(fd, done) : done(null));
  const io = { open: fs.open, read: fs.read, write: fs.write, writev: fs.writev, close };
  return { input: fs.createReadStream('', { fd, fs: io }), output: fs.createWriteStream('', { fd, fs: io }) };
}

/**
 * Terminal handles over a terminal descriptor. libuv opens the terminal again
 * for each handle, so it can make it non-blocking without affecting anyone
 * else, and each handle closes its own copy. The descriptor given is then
 * nobody's, and is closed here.
 *
 * Where libuv could not open its own copy, a handle uses the descriptor given
 * and closes it itself. Two such handles would close one descriptor twice,
 * the second time perhaps someone else's by then, so the reader must have its
 * own copy or the terminal is refused.
 *
 * @param {number} fd
 */
function terminalHandles(fd) {
  const input = new tty.ReadStream(fd);
  if (!ownCopy(input, fd)) {
    input.destroy();
    throw new Error('the terminal could not be reopened for reading');
  }
  const output = closedWhenFinished(new tty.WriteStream(fd));
  // Otherwise the writer uses the descriptor given, and closes it.
  if (ownCopy(output, fd)) fs.closeSync(fd);
  return { input, output };
}

/**
 * A Windows console's input and screen, each through a terminal handle, as
 * `process.stdin` and `process.stdout` read and write one. On Windows libuv
 * uses the descriptor it is given rather than a copy, and closes it, so each
 * handle owns one of the two. Destroyed, the reader stops even with a read
 * waiting: libuv ends it with an Enter keypress put into the console's input,
 * and drops what it read.
 *
 * Takes both descriptors over, and if it fails closes each once: through its
 * handle where one already has it, directly otherwise.
 *
 * @param {number} inFd  The console's input, open for reading and writing.
 * @param {number} outFd  Its screen.
 * @returns {{ input: NodeJS.ReadableStream & { destroy(): void }, output: NodeJS.WritableStream }}
 */
function consoleStreams(inFd, outFd) {
  /** @type {tty.ReadStream | undefined} */
  let input;
  try {
    if (!tty.isatty(inFd) || !tty.isatty(outFd)) throw new Error('no console is attached');
    input = new tty.ReadStream(inFd);
    return { input, output: closedWhenFinished(new tty.WriteStream(outFd)) };
  } catch (err) {
    if (input) input.destroy();
    else fs.closeSync(inFd);
    fs.closeSync(outFd);
    throw err;
  }
}

/**
 * A terminal write stream stays open after end(). This one is closed once
 * what was written has gone out.
 *
 * @param {tty.WriteStream} output
 */
function closedWhenFinished(output) {
  output.once('finish', () => output.destroy());
  return output;
}

/**
 * Whether a terminal stream's libuv handle has its own descriptor, not `fd`.
 * `_handle.fd` is not public API, but has been there since Node's earliest
 * releases. Unknown counts as no, the cautious answer above: refuse, or leave
 * a descriptor open, rather than close one a handle may be using.
 *
 * @param {tty.ReadStream | tty.WriteStream} stream
 * @param {number} fd
 */
function ownCopy(stream, fd) {
  const used = /** @type {any} */ (stream)._handle?.fd;
  return typeof used === 'number' && used !== fd;
}

/**
 * Ask a service — Slack, PagerDuty, an internal approvals app.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs=60000]
 * @returns {(req: ApprovalRequest) => Promise<ApprovalOutcome>}
 */
export function webhookApprover(opts) {
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return async (req) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(opts.url, {
        // Credentials go to this address only: a redirect could carry them elsewhere.
        redirect: 'error',
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) {
        return {
          approved: false,
          by: 'policy:approver-error',
          note: `approver returned HTTP ${res.status}`,
        };
      }
      const body = await res.json();
      return {
        approved: body?.approved === true,
        by: typeof body?.by === 'string' ? body.by : 'webhook',
        note: typeof body?.note === 'string' ? body.note : undefined,
      };
    } catch (err) {
      return {
        approved: false,
        by: 'policy:approver-unreachable',
        note: `could not reach the approver: ${/** @type {Error} */ (err).message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * @param {object} [config]
 * @param {'deny'|'tty'|'webhook'} [config.mode]
 * @param {string} [config.url]
 * @param {Record<string,string>} [config.headers]
 * @param {number} [config.timeoutMs]
 * @returns {(req: ApprovalRequest) => Promise<ApprovalOutcome>}
 */
export function approverFrom(config = {}) {
  switch (config.mode) {
    case 'tty':
      return ttyApprover(config);
    case 'webhook':
      if (!config.url) throw new Error('approval.mode "webhook" requires a url');
      return webhookApprover({ url: config.url, headers: config.headers, timeoutMs: config.timeoutMs });
    case 'deny':
    case undefined:
      return denyingApprover();
    default:
      throw new Error(`unknown approval mode "${config.mode}"`);
  }
}

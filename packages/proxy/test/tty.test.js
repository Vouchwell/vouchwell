import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

// The terminal approver against a real terminal: a pseudo-terminal, made by
// Python's pty module, as the child's controlling terminal. The fake terminal
// in proxy.test.js cannot show this bug: a file stream reading /dev/tty sat in
// a worker thread after its prompt was done, took the next line typed (the
// next prompt's answer), and kept the process from exiting.

const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import pty'], { stdio: 'ignore' }).status === 0);
const skip = process.platform === 'win32' ? 'no pseudo-terminals on Windows' : !python ? 'needs Python with the pty module' : false;

const APPROVE = new URL('../src/approve.js', import.meta.url).href;

// Answers each prompt as it appears ('' lets it time out), then reports what
// the child printed and whether it exited on its own.
const DRIVER = `
import os, pty, sys, time, select, signal, json
child, answers, limit = sys.argv[1], sys.argv[2].split(','), float(sys.argv[3])
pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[4], [sys.argv[4], child])
out, sent, ended, deadline = b'', 0, False, time.time() + limit
while time.time() < deadline:
    if select.select([master], [], [], 0.1)[0]:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            chunk = b''
        if not chunk:
            ended = True
            break
        out += chunk
    if sent < len(answers) and out.count(b'Approve?') > sent:
        if answers[sent]:
            time.sleep(0.1)
            os.write(master, (answers[sent] + '\\n').encode())
        sent += 1
if not ended:
    os.kill(pid, signal.SIGKILL)
os.waitpid(pid, 0)
print(json.dumps({'ended': ended, 'out': out.decode('utf-8', 'replace')}))
`;

/**
 * @param {string[]} answers  One per prompt; '' to let it time out.
 * @param {number} timeoutMs  The approver's deadline.
 */
async function approveAtTerminal(answers, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-tty-'));
  const driver = path.join(dir, 'drive.py');
  const child = path.join(dir, 'child.mjs');
  fs.writeFileSync(driver, DRIVER);
  fs.writeFileSync(child, `
    import { ttyApprover } from ${JSON.stringify(APPROVE)};
    const approve = ttyApprover({ timeoutMs: ${timeoutMs} });
    const req = (t) => ({ target: t, params: {}, reason: 'needs a person', rules: ['r'], actor: { principal: 'ops' } });
    const out = [];
    for (const t of ${JSON.stringify(answers.map((_, i) => `ops.call_${i}`))}) {
      const r = await approve(req(t));
      out.push([r.approved, r.by]);
    }
    console.log('RESULT ' + JSON.stringify(out));
  `);
  const proc = spawn(/** @type {string} */ (python), [driver, child, answers.join(','), '20', process.execPath]);
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  await new Promise((resolve) => proc.on('exit', resolve));
  const { ended, out } = JSON.parse(stdout);
  const result = /RESULT (.*)/.exec(out);
  assert.ok(result, `no result; the terminal showed:\n${out}`);
  return { ended, decisions: JSON.parse(result[1]) };
}

test('each prompt at a real terminal gets the answer typed for it, and the process exits', { skip }, async () => {
  const { ended, decisions } = await approveAtTerminal(['y', 'n', 'y'], 15_000);
  assert.deepEqual(decisions, [[true, 'tty'], [false, 'tty'], [true, 'tty']]);
  assert.equal(ended, true, 'nothing is left reading the terminal');
});

test('after a prompt times out, the next one still gets its answer', { skip }, async () => {
  const { ended, decisions } = await approveAtTerminal(['', 'y'], 800);
  assert.deepEqual(decisions, [[false, 'policy:timeout'], [true, 'tty']]);
  assert.equal(ended, true);
});

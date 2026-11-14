import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ProofLog, Policy, Recorder, PolicyDenied } from '../src/index.js';

// A URL, not a path: the child imports it, and on Windows an absolute path
// (D:\\…) is not a module specifier.
const INDEX = new URL('../src/index.js', import.meta.url).href;
const actor = { agent: 'a', session: 's', principal: 'p' };
const allow = { outcome: 'allow', policy: 'none', rules: [] };

function freshLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-writers-'));
  ProofLog.create(dir);
  return dir;
}

/** @param {ProofLog} log @param {string} target */
const record = (log, target) => log.append({ actor, action: { kind: 'tool_call', target, params: {} }, decision: allow });

const seqs = (dir) => fs.readFileSync(path.join(dir, 'entries.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq);

// Two `vw proxy` processes wrapping two MCP servers in one project write one
// log. Each used to append the sequence number it remembered: 0, 0, 1, and a
// log that reported tampering when nobody had touched it.
test('two writers on one log continue each other, and the log verifies', () => {
  const dir = freshLog();
  const a = ProofLog.open(dir);
  const b = ProofLog.open(dir);
  record(a, 'crm.lookup');
  record(b, 'fs.read');
  record(a, 'crm.update');
  record(b, 'fs.write');
  a.checkpoint();

  assert.deepEqual(seqs(dir), [0, 1, 2, 3]);
  const audit = ProofLog.open(dir, { readOnly: true }).audit();
  assert.equal(audit.ok, true, JSON.stringify(audit.issues));
  assert.equal(a.size, 4, 'a writer sees what the other appended');
});

test('two processes appending at the same time lose nothing and break nothing', async () => {
  const dir = freshLog();
  const script = `
    import { ProofLog } from ${JSON.stringify(INDEX)};
    const log = ProofLog.open(process.argv[1]);
    for (let i = 0; i < 40; i++) {
      log.append({ actor: { agent: 'a', session: process.argv[2], principal: 'p' },
        action: { kind: 'tool_call', target: 't' + i, params: {} },
        decision: { outcome: 'allow', policy: 'none', rules: [] } });
    }`;
  const run = (name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, name], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(stderr))));
  });
  await Promise.all([run('one'), run('two'), run('three')]);

  assert.deepEqual(seqs(dir), [...Array(120).keys()]);
  const audit = ProofLog.open(dir, { readOnly: true }).audit();
  assert.equal(audit.ok, true, JSON.stringify(audit.issues.slice(0, 3)));
});

test('a budget counts what another writer spent', async () => {
  const dir = freshLog();
  const policy = new Policy({
    version: 1,
    budgets: [{ id: 'refunds', match: { target: 'refund' }, field: 'metrics.amount_usd', limit: 100, window: '24h', then: 'deny' }],
  });
  const opts = { agent: 'a', principal: 'p', policy, metrics: (_t, args) => ({ amount_usd: args.amount }) };
  const first = new Recorder({ ...opts, log: ProofLog.open(dir) });
  const second = new Recorder({ ...opts, log: ProofLog.open(dir) });

  await first.run('refund', { amount: 60 }, () => 'ok');
  await assert.rejects(second.run('refund', { amount: 60 }, () => 'ok'), PolicyDenied, '$60 + $60 is over the $100 cap, whichever process spent it');
});

test('opening a log reads a last line with no newline, and refuses one that is not JSON', () => {
  const dir = freshLog();
  record(ProofLog.open(dir), 't');
  const file = path.join(dir, 'entries.jsonl');
  const line = fs.readFileSync(file, 'utf8').trim();
  fs.writeFileSync(file, line); // no trailing newline
  assert.equal(ProofLog.open(dir, { readOnly: true }).size, 1);
  fs.writeFileSync(file, `${line}\n{"seq": 1, "trunc`);
  assert.throws(() => ProofLog.open(dir, { readOnly: true }), /line 2 is not valid JSON/);
});

test('a log that shrinks under a writer is refused rather than appended to', () => {
  const dir = freshLog();
  const log = ProofLog.open(dir);
  record(log, 'a');
  record(log, 'b');
  fs.writeFileSync(path.join(dir, 'entries.jsonl'), '');
  assert.throws(() => record(log, 'c'), /truncated or rewritten/);
});

/**
 * `vw demo`: the five-minute demo, runnable from an installed CLI.
 *
 * Runs a real agent session through a real proxy against a real MCP server
 * (demo-server.js), then attacks the resulting log four ways and shows each
 * attack being caught. Nothing is mocked; the log it writes stays behind in a
 * temporary directory for `vw log`, `vw verify` and `vw dash` to explore.
 *
 * Every outcome it prints is also checked. If a call that should run is
 * blocked, a call that should be blocked runs, or an attack goes undetected,
 * the demo says so and exits 1, so `npm run demo` in CI is a real end-to-end
 * test rather than a recording.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ProofLog, Policy, verifyBundle, canonicalize, identityFromPem, signReceipt, entryHash, GENESIS_PREV, generateIdentity, cosign, verifyCheckpoint } from '@vouchwell/core';
import { McpProxy } from '@vouchwell/proxy';
import { LineFramer } from '@vouchwell/proxy/jsonrpc';
import { c, out } from './ui.js';

const SERVER = fileURLToPath(new URL('./demo-server.js', import.meta.url));

const POLICY = {
  version: 1,
  name: 'finance-ops',
  rules: [
    {
      id: 'deny.destructive-sql',
      when: { 'params.sql': { matches: '(?i)\\b(drop|truncate|delete\\s+from)\\b' } },
      then: 'deny',
      reason: 'destructive SQL from an agent is never permitted',
    },
    {
      id: 'escalate.customer-mail',
      when: { target: 'ops.send_email' },
      then: 'escalate',
      reason: 'anything that reaches a customer gets a human first',
    },
  ],
  budgets: [
    {
      id: 'refunds.daily',
      match: { target: 'ops.refund' },
      field: 'metrics.amount_usd',
      limit: 100,
      window: '24h',
      then: 'deny',
    },
  ],
  egress: { denySecrets: true },
};

/** @type {Array<[string, Record<string, unknown>, string, 'ran' | 'blocked']>} tool, arguments, note, expected */
const CALLS = [
  ['query', { sql: 'SELECT count(*) FROM orders WHERE status = $1' }, 'a harmless read', 'ran'],
  ['refund', { order: 'ord_8821', amount: 4500 }, '$45 refund — inside budget', 'ran'],
  ['refund', { order: 'ord_8822', amount: 3000 }, '$30 refund — $75 committed', 'ran'],
  ['refund', { order: 'ord_8823', amount: 9000 }, '$90 refund — would reach $165', 'blocked'],
  ['query', { sql: 'DELETE FROM customers WHERE churn_risk > 0.8' }, 'destructive SQL', 'blocked'],
  ['send_email', { to: 'sam@example.test', subject: 'Your refund', body: 'On its way.' }, 'outbound mail', 'ran'],
  ['query', { sql: "SELECT * FROM logs WHERE token = 'sk-ant-api03-Xk92mQvT1pLs8fR4nB6yH0jW'" }, 'a live credential in the args', 'blocked'],
];

/** @param {number} n @param {string} s */
function step(n, s) {
  out();
  out(c.bold(`${n}. ${s}`));
  out(c.grey('─'.repeat(72)));
}

/**
 * How to run `vw` again, as the person who started the demo can: `npx
 * vouchwell` when it came through npx, which leaves nothing on the PATH.
 *
 * @param {string | undefined} given
 */
function vwCommand(given) {
  if (given) return given;
  return process.env.npm_command === 'exec' ? 'npx vouchwell' : 'vw';
}

/**
 * @param {{ explore?: string }} [options]
 *   explore: the command that runs `vw`, for the hints at the end.
 * @returns {Promise<number>} 0 when every outcome was the expected one.
 */
export async function runDemo(options = {}) {
  let failures = 0;
  /** @param {boolean} pass @param {string} text */
  const check = (pass, text) => {
    if (!pass) failures++;
    out(`  ${pass ? c.green('✓') : c.red('✗')} ${text}`);
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vouchwell-demo-'));
  const log = ProofLog.create(dir);

  out();
  out(c.bold('  Vouchwell — every AI agent action, signed, chained, and provable'));
  out(c.grey(`  log ${log.logId}   key ${log.identity.kid}`));
  out(c.grey(`  ${dir}`));

  // ── 1. Run a session ──────────────────────────────────────────────────
  step(1, 'An agent works through a queue of tasks');

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  /** @type {Map<number, any>} */
  const replies = new Map();
  const framer = new LineFramer();
  stdout.on('data', (chunk) => {
    for (const { message } of framer.push(chunk)) {
      if (message && 'id' in message) replies.set(message.id, message);
    }
  });

  const proxy = new McpProxy({
    log,
    policy: new Policy(POLICY),
    actor: { agent: 'demo-agent', session: 'sess_demo', principal: 'ops@acme.test' },
    // One human, approving mail but not blindly: they decline anything that
    // still looks wrong after the policy escalated it.
    approver: async (req) => ({
      approved: req.target === 'ops.send_email',
      by: 'dana@acme.test',
      note: 'reviewed in the approvals channel',
    }),
    command: process.execPath,
    args: [SERVER],
    namespace: 'ops',
    metrics: { 'ops.refund': { amount_usd: { from: 'params.amount', scale: 0.01 } } },
    stdin,
    stdout,
    stderr: new PassThrough(),
  });

  const running = proxy.start();

  for (const [i, [name, args, note, expected]] of CALLS.entries()) {
    const id = i + 1;
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');

    const deadline = Date.now() + 5000;
    while (!replies.has(id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));

    const reply = replies.get(id);
    const blocked = reply?.result?.isError === true;
    const text = (reply?.result?.content?.[0]?.text ?? '').split('\n')[0];
    const label = blocked ? c.red('BLOCKED') : c.green('ran    ');
    out(`  ${label}  ${`ops.${name}`.padEnd(16)} ${c.grey(note)}`);
    if (blocked) out(`            ${c.yellow(text.replace('Blocked by Vouchwell policy. ', ''))}`);
    if (!reply) {
      failures++;
      out(`            ${c.red('✗ no reply from the proxy within 5s')}`);
    } else if ((blocked ? 'blocked' : 'ran') !== expected) {
      failures++;
      out(`            ${c.red(`✗ expected this call to be ${expected === 'ran' ? 'allowed' : 'blocked'}`)}`);
    }
  }

  stdin.end();
  await running;
  proxy.finalize();

  out();
  out(`  ${log.size} receipts written · ${proxy.stats.denied} actions refused · checkpoint signed`);

  // ── 2. Verify ─────────────────────────────────────────────────────────
  step(2, 'Anyone can verify the log — no trust in us required');

  const audit = ProofLog.open(dir, { readOnly: true }).audit();
  check(audit.ok, audit.ok ? 'every signature, chain link and checkpoint verifies' : 'problems found');
  out(c.grey(`  merkle root  ${audit.root}`));

  const bundle = JSON.parse(JSON.stringify(ProofLog.open(dir, { readOnly: true }).bundle()));
  const bundleCheck = verifyBundle(bundle);
  check(bundleCheck.ok, `the exported evidence bundle verifies standing alone (${bundleCheck.checked} receipts)`);
  out(c.grey('    no payloads, no salts, no database — one file an auditor can check offline'));

  // ── 3. Attack it ──────────────────────────────────────────────────────
  step(3, 'Four ways to cover your tracks, and what each one costs');

  /** @type {Array<{ name: string, how: string, run: (lines: string[]) => string[] }>} */
  const attacks = [
    {
      name: 'Edit a receipt in place',
      how: 'quietly reduce the amount on a refund that was already approved',
      run: (lines) => {
        const i = lines.findIndex((l) => JSON.parse(l).action.metrics?.amount_usd > 0);
        const r = JSON.parse(lines[i]);
        r.action.metrics.amount_usd = 1;
        lines[i] = canonicalize(r);
        return lines;
      },
    },
    {
      name: 'Delete a receipt',
      how: 'drop the entry that recorded the block',
      run: (lines) => lines.filter((l) => JSON.parse(l).decision.outcome !== 'deny'),
    },
    {
      name: 'Re-sign the whole chain',
      how: 'steal the signing key, remove an entry, rebuild every link',
      run: (lines) => {
        const identity = identityFromPem(fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'));
        const kept = lines.map((l) => JSON.parse(l)).filter((r) => r.decision.outcome !== 'deny');
        let prev = GENESIS_PREV;
        return kept.map((r, i) => {
          const { attest: _drop, ...body } = r;
          const signed = signReceipt(identity, { ...body, seq: i, prev });
          prev = entryHash(signed);
          return canonicalize(signed);
        });
      },
    },
    {
      name: 'Truncate the log',
      how: 'keep only the first few entries',
      run: (lines) => lines.slice(0, 4),
    },
  ];

  for (const attack of attacks) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vouchwell-attack-'));
    try {
      for (const f of ['config.json', 'key.pem', 'keyring.json', 'entries.jsonl', 'checkpoints.jsonl', 'salts.jsonl']) {
        fs.copyFileSync(path.join(dir, f), path.join(scratch, f));
      }
      const file = path.join(scratch, 'entries.jsonl');
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      fs.writeFileSync(file, attack.run(lines).join('\n') + '\n');

      const result = ProofLog.open(scratch, { readOnly: true }).audit();
      out(`  ${c.bold(attack.name)}`);
      out(c.grey(`    ${attack.how}`));
      if (result.ok) {
        failures++;
        out(`    ${c.red('✗ UNDETECTED')}`);
      } else {
        out(`    ${c.green('✓ caught')} — ${result.issues[0].message}`);
      }
    } finally {
      // The tampered copies hold a copy of the signing key: leave nothing behind.
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ── 4. Witnesses ──────────────────────────────────────────────────────
  step(4, 'Independent witnesses close the last hole');

  out(c.grey('  A log signing its own root can show two different histories to two'));
  out(c.grey('  auditors. Witnesses only counter-sign a root that extends the last one'));
  out(c.grey('  they saw, so a split view needs every witness to collude.'));
  out();

  const writable = ProofLog.open(dir);
  const w1 = generateIdentity().identity;
  const w2 = generateIdentity().identity;
  writable.trustKey(w1.kid, w1.publicKey);
  writable.trustKey(w2.kid, w2.publicKey);

  const cp = writable.checkpoints().at(-1);
  const cosigned = cosign(cosign(cp, w1), w2);
  // Pinned: the witnesses' keys come from us here, not from the checkpoint.
  const cpCheck = verifyCheckpoint(cosigned, writable.keyring, {
    minWitnesses: 2,
    trustedWitnesses: { [w1.kid]: w1.publicKey, [w2.kid]: w2.publicKey },
  });
  check(cpCheck.ok, `checkpoint at size ${cp.body.size} carries ${cpCheck.witnesses} independent witness signatures`);

  // ── 5. Erasure ────────────────────────────────────────────────────────
  step(5, 'Erasure without destroying the audit trail');

  // The first refund the agent actually made: the entry a customer might ask
  // us to erase.
  const target = writable.entries.find((r) => r.action.target === 'ops.refund' && r.phase === 'intent');
  const payload = CALLS.find(([name]) => name === 'refund')?.[1];

  const before = writable.reveal(target.seq, 'params', payload);
  check(before, `before: the payload of entry ${target.seq} can be confirmed against its commitment`);

  const shredded = writable.shred((r) => r.seq === target.seq);
  const after = ProofLog.open(dir, { readOnly: true });
  const stillOpenable = after.reveal(target.seq, 'params', payload);
  const stillValid = after.audit().ok;

  out(`  ${c.grey(`  shredded ${shredded} payload commitment (a GDPR Article 17 request)`)}`);
  check(!stillOpenable, 'after: that payload can no longer be confirmed by anyone, including us');
  check(stillValid, 'after: the audit trail still verifies end to end');

  // ── Done ──────────────────────────────────────────────────────────────
  const vw = vwCommand(options.explore);
  out();
  out(c.grey('─'.repeat(74)));
  if (failures) {
    out(`  ${c.red(`✗ ${failures} result${failures === 1 ? ' was' : 's were'} not what this demo expects.`)}`);
    out(`    Please report it: ${c.cyan('https://github.com/Vouchwell/vouchwell/issues')}`);
    out();
  }
  out('  Explore the log this demo just wrote:');
  out();
  out(`    ${c.cyan(`${vw} log    --log "${dir}"`)}`);
  out(`    ${c.cyan(`${vw} verify --log "${dir}"`)}`);
  out(`    ${c.cyan(`${vw} dash   --log "${dir}"`)}`);
  out();
  out('  Then put it in front of your own agent:');
  out();
  // The hooks and .mcp.json entries these write call `vw` by name, so someone
  // who came through npx needs it installed first.
  const viaNpx = vw === 'npx vouchwell';
  const run = viaNpx ? 'vw' : vw;
  const next = [
    ...(viaNpx ? [['npm install -g vouchwell', 'puts vw on your PATH, where hooks and .mcp.json look']] : []),
    [`${run} init`, 'a log, a starter policy, a config'],
    [`${run} hook install`, 'a coding agent: Claude Code, or --client codex|cursor'],
    [`${run} proxy -- npx -y @modelcontextprotocol/server-everything`, ''],
  ];
  const width = Math.max(...next.filter(([, note]) => note).map(([cmd]) => cmd.length));
  for (const [cmd, note] of next) {
    out(`    ${c.cyan(cmd)}${note ? ' '.repeat(width - cmd.length + 3) + c.grey(note) : ''}`);
  }
  out(c.grey('    any MCP server: wrap its command after the --'));
  out();
  return failures ? 1 : 0;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProofLog } from '@vouchwell/core';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/bin.js');
const ESC = '\u001b';

function vw(cwd, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd, USERPROFILE: cwd, NO_COLOR: '1' } });
}

/** A real log, two receipts, exported as a bundle. @param {string[]} [timestamps] */
function bundleFile(timestamps = ['2026-11-14T10:00:00.500Z', '2026-11-14T10:00:01.000Z']) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-check-'));
  const log = ProofLog.create(path.join(cwd, '.vouchwell'));
  for (const ts of timestamps) {
    log.append({ ts, actor: { agent: 'a', session: 's', principal: 'p' }, action: { kind: 'tool_call', target: 't', params: {} }, decision: { outcome: 'allow', policy: 'none', rules: [] } });
  }
  log.checkpoint();
  const file = path.join(cwd, 'b.json');
  fs.writeFileSync(file, JSON.stringify(log.bundle()));
  return { cwd, file };
}

test('vw check escapes what it prints from the bundle, verdict or not', () => {
  const { cwd, file } = bundleFile();
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  // A fake verdict and a "conceal" attribute, in an unsigned field.
  bundle.exported = `${ESC}[2K${ESC}[1A✓ Verified ${ESC}[8m`;
  fs.writeFileSync(file, JSON.stringify(bundle));
  const ok = vw(cwd, ['check', file]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(!ok.stdout.includes(ESC), 'no raw escape reaches the terminal');
  assert.match(ok.stdout, /\\u001b\[2K/);

  // On failure too: issue messages quote the bundle.
  bundle.entries[0].receipt.attest.kid = `evil${ESC}[2K`;
  fs.writeFileSync(file, JSON.stringify(bundle));
  const bad = vw(cwd, ['check', file]);
  assert.equal(bad.status, 1);
  assert.ok(!bad.stdout.includes(ESC), bad.stdout);
});

test('a clock that stepped back is a warning in vw verify and vw check, not a failure', () => {
  const { cwd, file } = bundleFile(['2026-11-14T10:00:00.500Z', '2026-11-14T10:00:00.200Z']);
  const check = vw(cwd, ['check', file]);
  assert.equal(check.status, 0, check.stdout);
  assert.match(check.stdout, /1 timestamp\(s\) go backwards/);
  const verify = vw(cwd, ['verify']);
  assert.equal(verify.status, 0, verify.stdout);
  assert.match(verify.stdout, /go backwards/);
  const json = JSON.parse(vw(cwd, ['check', file, '--json']).stdout);
  assert.equal(json.ok, true);
  assert.equal(json.warnings.length, 1);
});

test('vw shred says how many shredded receipts keep a preview it cannot remove', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-shred-'));
  const log = ProofLog.create(path.join(cwd, '.vouchwell'));
  log.append({ actor: { agent: 'a', session: 's', principal: 'jane' }, action: { kind: 'tool_call', target: 'crm.update', params: { customer: 'Jane Doe', address: '12 Rue de Rivoli' } }, decision: { outcome: 'allow', policy: 'none', rules: [] } });
  const dry = vw(cwd, ['shred', '--principal', 'jane']);
  assert.match(dry.stdout, /1 of these receipts keep a redacted preview/);
  const done = vw(cwd, ['shred', '--principal', 'jane', '--yes']);
  assert.equal(done.status, 0, done.stdout);
  assert.match(done.stdout, /shredded 1 payload commitment/);
  assert.match(done.stdout, /"previews": "none"/);
});

test('vw proxy records no previews when the config says none', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-previews-'));
  assert.equal(vw(cwd, ['init']).status, 0);
  const cfgFile = path.join(cwd, 'vouchwell.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), previews: 'none' }));
  const server = path.resolve(path.dirname(BIN), '../../../examples/fake-mcp-server.js');
  const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query', arguments: { sql: 'select name from customers' } } }) + '\n';
  const run = spawnSync(process.execPath, [BIN, 'proxy', '--no-remote', '--', process.execPath, server], { cwd, input, encoding: 'utf8', env: { ...process.env, HOME: cwd, USERPROFILE: cwd, NO_COLOR: '1' } });
  assert.equal(run.status, 0, run.stderr);
  const receipts = ProofLog.open(path.join(cwd, '.vouchwell'), { readOnly: true }).entries;
  assert.ok(receipts.length >= 2);
  for (const r of receipts) {
    assert.equal(r.action.params.preview, undefined);
    assert.equal(r.result?.payload?.preview, undefined);
    assert.equal(typeof r.action.params.hash, 'string', 'the commitment is still there');
  }
});

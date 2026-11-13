import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/bin.js');

/** Run `vw <args>` with its own temporary directory, so we can see what it leaves there. */
function vw(args, extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vouchwell-demo-test-'));
  const env = { ...process.env, NO_COLOR: '1', TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...extraEnv };
  delete env.npm_command;
  if (extraEnv.npm_command) env.npm_command = extraEnv.npm_command;
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, cwd: tmp });
  return { ...res, tmp };
}

test('vw demo runs a session, catches every attack, and exits 0', () => {
  const res = vw(['demo']);
  assert.equal(res.status, 0, res.stdout + res.stderr);

  // The three calls the policy exists to stop, and nothing else.
  assert.equal(res.stdout.match(/^ {2}BLOCKED /gm)?.length, 3, res.stdout);
  assert.equal(res.stdout.match(/^ {2}ran {6}/gm)?.length, 4, res.stdout);
  assert.equal(res.stdout.match(/✓ caught/g)?.length, 4, res.stdout);
  assert.doesNotMatch(res.stdout, /✗|UNDETECTED/);

  // The log it points at is real, and verifies with the ordinary command.
  const dir = res.stdout.match(/vw verify --log "([^"]+)"/)?.[1];
  assert.ok(dir, 'expected the demo to name its log');
  const verify = spawnSync(process.execPath, [BIN, 'verify', '--log', dir], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);

  // The tampered copies held a copy of the signing key; none may be left behind.
  const left = fs.readdirSync(res.tmp);
  assert.deepEqual(left.filter((f) => f.startsWith('vouchwell-attack-')), []);
  assert.equal(left.filter((f) => f.startsWith('vouchwell-demo-')).length, 1);
});

test('run through npx, vw demo explores with npx and installs vw before anything that calls it by name', () => {
  const res = vw(['demo'], { npm_command: 'exec' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /npx vouchwell log {4}--log "/);
  // `vw hook install` writes hooks that run `vw hook`, which npx leaves off the PATH.
  const install = res.stdout.indexOf('npm install -g vouchwell');
  assert.ok(install > 0, res.stdout);
  assert.ok(install < res.stdout.indexOf('vw hook install'), res.stdout);
  assert.doesNotMatch(res.stdout, /npx vouchwell hook install/);
});

test('installed, vw demo hints at vw itself', () => {
  const res = vw(['demo']);
  assert.match(res.stdout, /^ {4}vw hook install/m);
  assert.doesNotMatch(res.stdout, /npx vouchwell|npm install -g/);
});

test('vw help lists vw demo first', () => {
  const res = vw(['help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Setup\n {4}vw demo +see it work/);
});

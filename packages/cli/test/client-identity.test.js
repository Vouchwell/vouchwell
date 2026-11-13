import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../src/bin.js');
const SERVER = path.resolve(HERE, '../../../examples/fake-mcp-server.js');

/** What an MCP client sends first, then one tool call. */
const SESSION = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor-vscode', version: '1.2.3' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'query', arguments: { sql: 'SELECT 1' } } },
].map((m) => JSON.stringify(m)).join('\n') + '\n';

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {string} [input]
 */
function vw(cwd, args, input) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 20000,
    // A private home, so no real hub credentials are read or written.
    env: { ...process.env, HOME: cwd, USERPROFILE: cwd, NO_COLOR: '1' },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** @param {string} cwd */
function lastReceipts(cwd) {
  const { stdout } = vw(cwd, ['log', '--json']);
  return JSON.parse(stdout).filter((/** @type {any} */ r) => r.action.target === 'query');
}

function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vouchwell-client-'));
  assert.equal(vw(cwd, ['init']).code, 0);
  return cwd;
}

test('vw init no longer writes an agent into the config', () => {
  const cwd = project();
  const config = JSON.parse(fs.readFileSync(path.join(cwd, 'vouchwell.config.json'), 'utf8'));
  assert.equal('agent' in config.actor, false);
  assert.equal(typeof config.actor.principal, 'string');
});

test('from a fresh vw init, receipts name the MCP client as the agent and as the client', () => {
  const cwd = project();
  const run = vw(cwd, ['proxy', '--no-remote', '--', process.execPath, SERVER], SESSION);
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /placeholder/);

  const receipts = lastReceipts(cwd);
  assert.ok(receipts.length >= 1);
  for (const r of receipts) {
    assert.equal(r.actor.agent, 'cursor-vscode');
    assert.deepEqual(r.actor.client, { name: 'cursor-vscode', version: '1.2.3' });
  }
  assert.equal(vw(cwd, ['verify']).code, 0);
});

test('a config still carrying the old placeholder keeps it, records the client, and says so', () => {
  const cwd = project();
  const file = path.join(cwd, 'vouchwell.config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.actor.agent = 'claude-opus-5';
  fs.writeFileSync(file, JSON.stringify(config, null, 2));

  const run = vw(cwd, ['proxy', '--no-remote', '--', process.execPath, SERVER], SESSION);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /actor\.agent is "claude-opus-5", the placeholder vw init used to write/);

  const r = lastReceipts(cwd)[0];
  assert.equal(r.actor.agent, 'claude-opus-5');
  assert.deepEqual(r.actor.client, { name: 'cursor-vscode', version: '1.2.3' });
});

test('an agent someone chose is used as is, with no hint', () => {
  const cwd = project();
  const file = path.join(cwd, 'vouchwell.config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.actor.agent = 'support-bot';
  fs.writeFileSync(file, JSON.stringify(config, null, 2));

  const run = vw(cwd, ['proxy', '--no-remote', '--', process.execPath, SERVER], SESSION);
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /placeholder/);
  assert.equal(lastReceipts(cwd)[0].actor.agent, 'support-bot');
});

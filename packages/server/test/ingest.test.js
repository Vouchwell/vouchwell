import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, buildReceipt, signReceipt, entryHash, GENESIS_PREV, verifyBundle } from '@vouchwell/core';
import { Hub } from '../src/app.js';
import { Auth } from '../src/auth.js';

/** @type {Hub} */
let hub;
let base = '';
let token = '';

class Agent {
  /** @param {string} log */
  constructor(log) {
    this.log = log;
    this.identity = generateIdentity().identity;
    this.seq = 0;
    this.prev = GENESIS_PREV;
  }

  /** @param {Partial<{ prev: any }>} [override] */
  make(override = {}) {
    const { body } = buildReceipt({
      log: this.log,
      seq: this.seq,
      prev: this.prev,
      actor: { agent: 'a', runtime: 'test', session: 's', principal: 'p' },
      action: { kind: 'tool_call', target: 't', params: { n: this.seq } },
      decision: { outcome: 'allow', policy: 'p1', rules: [] },
      ...override,
    });
    const r = signReceipt(this.identity, body);
    this.seq++;
    this.prev = entryHash(r);
    return r;
  }
}

/** @param {string} method @param {string} p @param {any} [body] */
async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** @param {Agent} agent */
const register = (agent) => api('POST', '/v1/logs', { slug: agent.log, kid: agent.identity.kid, publicKey: agent.identity.publicKey });

before(async () => {
  hub = new Hub({
    database: ':memory:',
    checkpointEvery: 1000,
    apiRate: { capacity: 100000, refillPerSec: 100000 },
    ingestRate: { capacity: 100000, refillPerSec: 100000 },
  });
  base = (await hub.listen(0)).url.replace('0.0.0.0', '127.0.0.1');
  const org = hub.store.createOrg({ slug: 'acme', name: 'Acme' });
  token = new Auth(hub.store).createKey({ orgId: org.id, name: 'agent', scopes: ['receipts:write', 'logs:write', 'logs:read', 'receipts:read'] }).token;
});

after(async () => {
  await hub.close();
});

test('a batch id already used by another log is refused cleanly, and the log stays consistent', async () => {
  const a = new Agent('alpha');
  const b = new Agent('beta');
  assert.equal((await register(a)).status, 200);
  assert.equal((await register(b)).status, 200);
  assert.equal((await api('POST', '/v1/logs/alpha/receipts', { receipts: [a.make()], batchId: 'shared-id' })).status, 200);

  const reused = await api('POST', '/v1/logs/beta/receipts', { receipts: [b.make(), b.make()], batchId: 'shared-id' });
  assert.equal(reused.status, 409, JSON.stringify(reused.json));
  assert.equal(reused.json.error.code, 'batch_id_in_use');

  // Resent under a new id, the same receipts go in, and the hub's root is
  // the root of what it stores.
  b.seq = 0;
  b.prev = GENESIS_PREV;
  const again = await api('POST', '/v1/logs/beta/receipts', { receipts: [b.make(), b.make()], batchId: 'fresh-id' });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  const bundle = (await api('GET', '/v1/logs/beta/bundle')).json;
  assert.equal(bundle.entries.length, 2);
  const res = verifyBundle(bundle);
  assert.equal(res.ok, true, res.issues.join('; '));
});

test('a batch that fails mid-commit leaves no trace in the hub\'s tree', async () => {
  const c = new Agent('gamma');
  assert.equal((await register(c)).status, 200);
  assert.equal((await api('POST', '/v1/logs/gamma/receipts', { receipts: [c.make(), c.make()] })).status, 200);

  // The next commit fails after its receipts were inserted and the cached
  // tree appended to: the logs UPDATE throws, and the transaction rolls back.
  const db = hub.store.db;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.startsWith('UPDATE logs SET size')) {
      db.prepare = prepare;
      throw new Error('disk full');
    }
    return prepare(sql);
  };
  const next = [c.make(), c.make()];
  const failed = await api('POST', '/v1/logs/gamma/receipts', { receipts: next });
  assert.equal(failed.status, 500);
  db.prepare = prepare;

  // Retried, it succeeds, and the root covers four entries, not six.
  const retried = await api('POST', '/v1/logs/gamma/receipts', { receipts: next });
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(retried.json.size, 4);
  const res = verifyBundle((await api('GET', '/v1/logs/gamma/bundle')).json);
  assert.equal(res.ok, true, res.issues.join('; '));
});

test('a receipt whose prev is not a string is a 422, not a crash', async () => {
  const d = new Agent('delta');
  assert.equal((await register(d)).status, 200);
  const res = await api('POST', '/v1/logs/delta/receipts', { receipts: [d.make({ prev: 0 })] });
  assert.equal(res.status, 422, JSON.stringify(res.json));
  assert.match(res.json.error.message, /no prev hash/);
});

// Type-checked, never run, by `npm run types -- --check`. It imports the
// packages by name, so TypeScript resolves them through each package.json the
// way it would after `npm install`. Every `@ts-expect-error` below must be an
// error: if a declaration ever degrades to `any`, that line stops erroring and
// the check fails.

import fs from 'node:fs';
import {
  ProofLog,
  Policy,
  Recorder,
  PolicyDenied,
  recordTools,
  verifyBundle,
  composePolicy,
  type RecorderOptions,
} from '@vouchwell/core';
import { McpProxy } from '@vouchwell/proxy';
import { LineFramer, encode } from '@vouchwell/proxy/jsonrpc';
import { denyingApprover } from '@vouchwell/proxy/approve';
import { RemoteSink } from '@vouchwell/proxy/remote';
import { serve } from '@vouchwell/dashboard';
import { Hub, VERSION } from '@vouchwell/server';

// The README's library example.
const log = ProofLog.open('.vouchwell');
const policy = Policy.parse(fs.readFileSync('vouchwell.policy.json', 'utf8'));
const options: RecorderOptions = {
  log,
  agent: 'support-bot',
  principal: 'ops@acme.com',
  policy,
  metrics: (tool, args): Record<string, number> => (tool === 'stripe.refund' ? { amount_usd: (args as { amount: number }).amount } : {}),
};
const rec = new Recorder(options);

const refund = rec.wrap('stripe.refund', async ({ order, amount }: { order: string; amount: number }) => ({ id: `re_${order}`, amount }));
export async function useRefund(): Promise<string> {
  try {
    const result = await refund({ order: 'o_1', amount: 45 });
    return result.id;
  } catch (e) {
    if (e instanceof PolicyDenied) return e.target;
    throw e;
  }
}
// @ts-expect-error: the wrapped function keeps its parameter types
refund({ order: 'o_1', amount: 'forty-five' });

// @ts-expect-error: an agent is required
new Recorder({ log, principal: 'ops@acme.com' });

const tools = recordTools(rec, { weather: { execute: async (city: string) => `sunny in ${city}` } });
export const weather: (city: string) => Promise<string> = tools.weather.execute;

const check = verifyBundle(JSON.parse(fs.readFileSync('evidence.json', 'utf8')), { minWitnesses: 1 });
export const verified: boolean = check.ok;
// @ts-expect-error: ok is a boolean
export const notAString: string = check.ok;

export const composed = new Policy(composePolicy(['secrets', 'payments']));

new McpProxy({
  log,
  policy,
  actor: { session: 'sess_1', principal: 'ops@acme.com' },
  approver: denyingApprover(),
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-everything'],
});

export const framed: string = encode({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
export const framer = new LineFramer();
export type Sink = RemoteSink;
export const dashboardUrl: Promise<string> = serve({ dir: '.vouchwell', port: 7788 });
export type HubType = Hub;
export const hubVersion: string = VERSION;

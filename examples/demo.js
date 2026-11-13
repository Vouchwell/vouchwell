#!/usr/bin/env node
/**
 * The five-minute demo, from a checkout: `npm run demo`.
 *
 * The demo itself ships with the CLI as `vw demo`, so anyone can run it with
 * `npx vouchwell demo` and no clone. This runs the same code, and points its
 * closing hints at the CLI in this repository.
 */

import { runDemo } from '../packages/cli/src/demo.js';

process.exitCode = await runDemo({ explore: 'node packages/cli/src/bin.js' });

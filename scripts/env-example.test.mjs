import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedFiles } from './repo-hygiene.mjs';

// .env.example names every environment variable Vouchwell reads, so a
// deployment can see what it may set. A variable read in code and listed
// nowhere is how a hub works on a laptop and not once deployed: this keeps
// the list complete.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Code that reads the environment when it runs: the packages, the verify
 * action, the Claude Code plugin and this repository's scripts. Tests are
 * left out; they set variables for the code under test.
 */
const SOURCE = /^(packages\/[^/]+\/src\/.+|verify\/[^/]+|plugins\/vouchwell\/scripts\/[^/]+|scripts\/[^/]+)\.(js|mjs|cjs)$/;
const TEST = /\.test\.(js|mjs|cjs)$/;

/**
 * `process.env.NAME`, `process.env['NAME']`, and the same through an `env`
 * parameter (the hub's bin.js and signer.js take one). Not `.env` after a
 * dot: that is a file name such as .env.example in a comment.
 */
const READ = /(?:\bprocess\.env|(?<![.\w$])env)(?:\.([A-Za-z_]\w*)|\[\s*['"]([A-Za-z_]\w*)['"]\s*\])/g;

/**
 * Names built from a template, which READ cannot follow: the hub's signer,
 * configured per role (signerFor in packages/server/src/signer.js).
 */
const PER_ROLE_SUFFIXES = ['SIGNER', 'PUBLIC_KEY', 'SIGNER_COMMAND', 'SIGNER_ARGS', 'SIGNER_URL', 'SIGNER_TOKEN'];
const PER_ROLE = ['HUB', 'WITNESS'].flatMap((role) => PER_ROLE_SUFFIXES.map((s) => `VOUCHWELL_${role}_${s}`));

/**
 * Every variable the code under `root` reads, with the files that read it.
 *
 * @param {string} root
 * @param {string[]} files
 * @returns {Map<string, string[]>}
 */
export function variablesRead(root, files) {
  /** @type {Map<string, string[]>} */
  const found = new Map();
  for (const file of files) {
    if (!SOURCE.test(file) || TEST.test(file)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(READ)) {
      // Windows spells it Path; the variable is PATH, case-insensitively.
      const name = (m[1] ?? m[2]) === 'Path' ? 'PATH' : (m[1] ?? m[2]);
      found.set(name, [...new Set([...(found.get(name) ?? []), file])]);
    }
  }
  return found;
}

/** @param {string} text  An .env.example. @returns {Set<string>} The names it lists. */
const listedIn = (text) => new Set(text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g));

test('.env.example lists every environment variable the code reads', () => {
  const listed = listedIn(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'));
  const read = variablesRead(ROOT, trackedFiles(ROOT));
  const missing = [...read].filter(([name]) => !listed.has(name)).map(([name, files]) => `${name} (${files.join(', ')})`);
  missing.push(...PER_ROLE.filter((name) => !listed.has(name)));
  assert.deepEqual(missing, [], `add these to .env.example, by name only:\n  ${missing.join('\n  ')}`);
  assert.ok(read.size > 50, `the scan found only ${read.size} variables: has READ stopped matching?`);
});

test('a variable read in new code, by either spelling, is found', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-env-'));
  fs.mkdirSync(path.join(dir, 'packages/cli/src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'packages/cli/test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages/cli/src/new.js'),
    "const a = process.env.VOUCHWELL_NEW_ONE;\nconst b = env['VOUCHWELL_OTHER'];\n// see .env.example\n");
  fs.writeFileSync(path.join(dir, 'packages/cli/test/new.test.js'), 'process.env.ONLY_IN_A_TEST = "1";\n');
  const files = ['packages/cli/src/new.js', 'packages/cli/test/new.test.js'];
  assert.deepEqual([...variablesRead(dir, files).keys()].sort(), ['VOUCHWELL_NEW_ONE', 'VOUCHWELL_OTHER']);
});

test("the per-role signer names are the ones signer.js builds", () => {
  const signer = fs.readFileSync(path.join(ROOT, 'packages/server/src/signer.js'), 'utf8');
  for (const suffix of PER_ROLE_SUFFIXES) {
    assert.ok(signer.includes('`VOUCHWELL_${upper}_' + suffix + '`'), `signer.js no longer reads VOUCHWELL_<ROLE>_${suffix}`);
  }
  assert.match(signer, /role\.toUpperCase\(\)/);
  assert.match(signer, /@param \{'hub'\|'witness'\} role/);
});

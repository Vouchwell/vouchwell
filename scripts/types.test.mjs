import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGES, staleFiles } from './types.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Whether the declarations are current takes TypeScript to answer, so CI's
// `types` job does that. This is the part that needs nothing installed: that
// every entry point a package publishes has declarations, and that they ship.
test('every published entry point has committed declarations, and they are in the package', () => {
  const problems = [];
  for (const pkg of PACKAGES) {
    const dir = path.join(ROOT, 'packages', pkg);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (!manifest.files.includes('types')) problems.push(`${manifest.name}: "types" is not in files, so npm would not publish it`);
    if (!manifest.types || !fs.existsSync(path.join(dir, manifest.types))) problems.push(`${manifest.name}: "types" (${manifest.types}) does not exist`);
    for (const [entry, target] of Object.entries(manifest.exports)) {
      if (typeof target !== 'object' || !target.types || !target.default) {
        problems.push(`${manifest.name}: exports["${entry}"] has no types condition`);
        continue;
      }
      if (Object.keys(target)[0] !== 'types') problems.push(`${manifest.name}: exports["${entry}"] lists types after another condition, and TypeScript would not reach it`);
      if (!fs.existsSync(path.join(dir, target.types))) problems.push(`${manifest.name}: exports["${entry}"].types (${target.types}) does not exist`);
      if (!fs.existsSync(path.join(dir, target.default))) problems.push(`${manifest.name}: exports["${entry}"].default (${target.default}) does not exist`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every source file has a declaration, and no declaration is left over from a deleted one', () => {
  const problems = [];
  for (const pkg of PACKAGES) {
    const src = fs.readdirSync(path.join(ROOT, 'packages', pkg, 'src')).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '.d.ts'));
    const types = fs.readdirSync(path.join(ROOT, 'packages', pkg, 'types')).filter((f) => f.endsWith('.d.ts'));
    for (const f of src) if (!types.includes(f)) problems.push(`packages/${pkg}/types/${f} is missing: run npm run types`);
    for (const f of types) if (!src.includes(f)) problems.push(`packages/${pkg}/types/${f} has no source: run npm run types`);
  }
  assert.deepEqual(problems, []);
});

test('staleFiles names what is missing, changed and left over', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-types-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-types-b-'));
  fs.writeFileSync(path.join(a, 'same.d.ts'), 'x');
  fs.writeFileSync(path.join(b, 'same.d.ts'), 'x');
  fs.writeFileSync(path.join(a, 'changed.d.ts'), 'old');
  fs.writeFileSync(path.join(b, 'changed.d.ts'), 'new');
  fs.writeFileSync(path.join(a, 'removed.d.ts'), 'x');
  fs.writeFileSync(path.join(b, 'added.d.ts'), 'x');
  assert.deepEqual(staleFiles(a, b, 't').sort(), [
    't/added.d.ts is missing',
    't/changed.d.ts is out of date',
    't/removed.d.ts is no longer generated',
  ]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['packages/core', 'packages/proxy', 'packages/dashboard', 'packages/server', 'packages/cli'];
const BUILTINS = new Set(builtinModules);

/** The package a bare specifier names: "@scope/name/sub" is "@scope/name", "name/sub" is "name". */
function packageOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every package imported, statically or with import(), by the .js files under `dir`. */
function importsIn(dir) {
  /** @type {Map<string, string>} package -> first file that imports it */
  const found = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    const text = fs.readFileSync(file, 'utf8');
    // Only specifiers shaped like a package name, so the word "from" in a
    // string or a comment cannot pass for an import.
    for (const [, spec] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w./-]*)?)['"]/g)) {
      const name = packageOf(spec);
      if (BUILTINS.has(name)) continue;
      if (!found.has(name)) found.set(name, path.relative(ROOT, file));
    }
  }
  return found;
}

// The monorepo's workspaces link every package to every other, so an import a
// package never declares still resolves here, and every test passes. Installed
// from npm, it does not resolve. `vw dash` shipped that way in 0.8.0: the CLI
// imported @vouchwell/dashboard without depending on it, so the command failed
// on every fresh `npm install -g vouchwell`.
test('every published package declares each package its source imports', () => {
  const problems = [];
  for (const rel of PACKAGES) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, rel, 'package.json'), 'utf8'));
    const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }));
    for (const [name, file] of importsIn(path.join(ROOT, rel, 'src'))) {
      if (name === pkg.name || declared.has(name)) continue;
      problems.push(`${pkg.name} imports ${name} (in ${file}) but does not list it in dependencies`);
    }
  }
  assert.deepEqual(problems, []);
});

// The hub image installs with --offline: npm only links the workspaces it was
// given. A workspace dependency missing from the Dockerfile fails the image
// build, which only CI's docker job runs; this fails `npm test` instead. It
// caught exactly that when the CLI started depending on the dashboard.
test('the Dockerfile copies every workspace its packages depend on', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const copied = new Set([...dockerfile.matchAll(/^COPY\s+packages\/([\w-]+)\/package\.json\s/gm)].map((m) => m[1]));
  const sources = new Set([...dockerfile.matchAll(/^COPY\s+packages\/([\w-]+)\s+packages\/\1\s*$/gm)].map((m) => m[1]));
  assert.ok(copied.size > 0, 'expected COPY lines for workspace package.json files');
  assert.deepEqual([...sources].sort(), [...copied].sort(), 'each workspace whose package.json is copied must have its source copied too');

  /** @type {Map<string, string>} package name -> workspace directory name */
  const dirOf = new Map(PACKAGES.map((rel) => [JSON.parse(fs.readFileSync(path.join(ROOT, rel, 'package.json'), 'utf8')).name, path.basename(rel)]));
  const missing = [];
  for (const dir of copied) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const depDir = dirOf.get(dep);
      if (depDir && !copied.has(depDir)) missing.push(`${pkg.name} depends on ${dep}, but the Dockerfile does not copy packages/${depDir}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the scan sees dynamic imports, which is how the CLI loads the dashboard', () => {
  const cli = importsIn(path.join(ROOT, 'packages/cli/src'));
  assert.ok(cli.has('@vouchwell/dashboard'), 'expected to find the dashboard import in the CLI');
});

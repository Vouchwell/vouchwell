# Contributing to Vouchwell

Bug reports, fixes, docs and new policy templates are all welcome. This file
covers how to get the repository running, what CI checks, and the few rules
that keep a tool like this trustworthy.

## Reporting a bug or asking for a feature

Open an issue and pick the template that fits. For a bug, the most useful
things are the output of `vw --version`, the exact command you ran, and what
it printed. If it's a bug in verification, a bundle from `vw export` that
shows it is better than any description.

**Security issues go through private reporting, not public issues.** See
[SECURITY.md](SECURITY.md) for what counts and what happens next.

Not sure whether something is a bug? Open a blank issue and ask.

## Getting set up

You need Node.js 22.13 or newer to run the whole test suite (the hub uses
Node's built-in SQLite). The published core and CLI support Node 20.11, and CI
checks that separately. Python 3.9+ is only needed for the Python SDK.

```bash
git clone https://github.com/Vouchwell/vouchwell.git
cd vouchwell
npm install
npm test
```

`npm install` only links the workspace packages to each other. There are no
third-party npm packages to download.

Other commands you'll use:

```bash
npm run demo                                   # end-to-end demo; exits 1 if any result is off
npm run vw -- init                             # run the CLI from source
npm test -w @vouchwell/core                    # one package's tests
node --test packages/core/test/merkle.test.js  # one test file
npm run types                                  # regenerate the TypeScript declarations
npm run hub -- serve                           # a local hub on :8787
```

### Python SDK

```bash
python -m pip install "./sdk/python[test]"
cd sdk/python
python -m pytest -q
```

The interop tests run the JavaScript CLI against logs written in Python and
the other way round, so run `npm install` at the repository root first. On
Python 3.10+ the test extras also install `langchain-core` and
`openai-agents`, so the adapters are tested against the real frameworks.

### Website

`site/` is static HTML, CSS and JavaScript with no build step. Preview it with:

```bash
python3 -m http.server -d site 8000
```

Its tests are part of `npm test`. The page loads nothing from other origins,
and a test enforces that, so fonts and scripts are served from `site/`.

## Where things are

| Path | What it is |
| --- | --- |
| `packages/core` | Receipts, the Merkle log, the policy engine, redaction |
| `packages/proxy` | The MCP proxy, and the client that ships receipts to a hub |
| `packages/cli` | The `vw` command |
| `packages/dashboard` | `vw dash` |
| `packages/server` | The hub |
| `sdk/python` | The Python SDK, wire-compatible with the packages above |
| `plugins/vouchwell` | The Claude Code plugin |
| `verify` | The GitHub Action that checks evidence bundles |
| `site` | vouchwell.axonscape.com, including a second verifier (`site/verify.js`) |
| `docs` | Guides, the threat model and the audit brief |

## Ground rules

These are what reviewers look for first.

- **No new dependencies in the npm packages.** They use Node's standard
  library only. The Python SDK has one dependency, `cryptography`. If you
  think something needs a library, open an issue before writing the code.
- **Don't break the format.** Receipts and bundles are versioned (`"v": 1`).
  A log written by any released version must keep verifying, and older
  verifiers must keep accepting new receipts: add optional fields, don't
  change what existing ones mean.
- **Verification lives in three places:** `packages/core`, `sdk/python` and
  `site/verify.js`, which deliberately shares no code with the CLI. A change
  to what counts as valid has to land in all three. The interop tests and the
  site's differential tests fail when they disagree.
- **Fail closed.** A policy that doesn't parse is an error, not an allow. An
  escalation nobody answers is a denial. New policy features need to hold to
  the same standard.
- **Tests come with the change.** A bug fix includes a test that fails
  without it. CI runs the suite on Linux, macOS and Windows with Node 22 and
  24, the core on Node 20.11, and the Python SDK on 3.9 and 3.13.
- **Types come from the JSDoc.** The TypeScript declarations in
  `packages/*/types/` are generated from it and committed. If you change an
  exported function, class or its JSDoc, run `npm run types` and commit the
  result. CI fails when they're out of date, and type-checks
  `scripts/types-consumer.ts` against them.
- **Style:** plain ES modules, no build step, types in JSDoc comments,
  two-space indent, single quotes, semicolons. There's no linter, so match
  the file you're editing. Comments should explain why, not restate the code.

## Pull requests

- Keep a pull request to one change. Small ones get reviewed faster.
- Write a short commit subject, usually with the area first (`CLI: …`,
  `Site: …`, `Docker: …`), and a body that says why the change is needed.
- Add a line under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md) for
  anything a user would notice.
- Run `npm test` before pushing, and `npm run demo` if you touched the core,
  the proxy or the CLI.
- Don't bump versions. Maintainers cut releases; the process is in
  [docs/PUBLISHING.md](docs/PUBLISHING.md).

Issues labelled
[good first issue](https://github.com/Vouchwell/vouchwell/labels/good%20first%20issue)
are a reasonable place to start.

## Working here with Claude Code

This repository records its own agent sessions: `.claude/settings.json` runs
`vw hook` on every tool call. If you use Claude Code here:

- Run `npm install` first. The hooks run the CLI from this checkout.
- The project policy in `.claude/vouchwell.policy.json` refuses some
  commands, force pushes among them. That's on purpose.
- At the end of a session the hook writes `evidence/<log id>.json`. Either
  commit it together with its signing key in `evidence/log-keys.json` (see
  [evidence/README.md](evidence/README.md)), or leave it out of your commit.
  CI fails any bundle signed by a key that isn't listed there.

## License

Vouchwell is licensed under [Apache-2.0](LICENSE). Contributions are accepted
under the same license, as section 5 of it describes. There is no CLA.

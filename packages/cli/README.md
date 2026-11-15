# vouchwell

**Guardrails and tamper-evident receipts for AI agents.**

[![CI](https://github.com/Vouchwell/vouchwell/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Vouchwell/vouchwell/actions/workflows/ci.yml?query=branch%3Amain)
[![npm](https://img.shields.io/npm/v/vouchwell)](https://www.npmjs.com/package/vouchwell)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/Vouchwell/vouchwell/blob/main/packages/cli/LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-0%20external-brightgreen)](https://github.com/Vouchwell/vouchwell/blob/main/packages/cli/package.json)

Your agents run shell commands, spend money, send mail, and touch customer
data. When something goes wrong, "our logs say it didn't" is not an answer —
your logs are a text file you can edit.

Vouchwell makes every agent action **policy-gated before it runs** and
**cryptographically provable afterwards**. It works with any MCP server, and
with the coding agents' own tools in Claude Code, Codex and Cursor.

## See it first

```bash
npx vouchwell demo
```

A second or two, nothing installed, nothing written to your directory. An
agent works through a queue; the policy blocks a refund over budget,
destructive SQL and a leaked API key; then the log is attacked four ways and
every attack is caught:

```
BLOCKED  ops.refund   budget refunds.daily would be exceeded: 75 already
                      committed plus 90 proposed, against a cap of 100 per 24h
BLOCKED  ops.query    destructive SQL from an agent is never permitted
BLOCKED  ops.query    arguments contain anthropic_key; policy forbids sending
                      these to a tool

Edit a receipt in place    ✓ caught — signature does not verify
Delete a receipt           ✓ caught — expected seq 6, found 8
Re-sign the whole chain    ✓ caught — a signed checkpoint covers 11 entries but the log holds only 8
Truncate the log           ✓ caught — entries have been removed
```

## Put it in front of your agent

```bash
npm install -g vouchwell
```

**A coding agent.** Every shell command, file edit, read and fetch is checked
against your policy before it runs, and gets a receipt:

```bash
vw policy template coding-agent shell-safety secrets --out vouchwell.policy.json
vw hook install                    # Claude Code
vw hook install --client codex     # OpenAI Codex CLI
vw hook install --client cursor    # Cursor
```

In Claude Code you can use the plugin instead, with nothing to configure:

```
/plugin marketplace add Vouchwell/vouchwell
/plugin install vouchwell@vouchwell
```

**Any MCP server.** Put `vw proxy` in front of its command. This is the whole
integration:

```jsonc
// .mcp.json — before
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "./docs"] }

// after
{ "command": "vw", "args": ["proxy", "--namespace", "fs", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "./docs"] }
```

Run `vw init` first for a log, a starter policy and a config. Every tool call
now hits your policy first, and every decision — allowed, blocked, or
escalated to a human — lands in an append-only log an outside party can
verify without trusting you. `vw proxy --monitor` blocks nothing and records
what the policy *would* have blocked, to try a policy on real traffic first.

**Let an agent read its own record.** `vw mcp` serves a log as a read-only
MCP server, so any MCP client can answer "what did you do?" and "prove it":

```json
{ "mcpServers": { "vouchwell": { "command": "npx", "args": ["-y", "vouchwell", "mcp"] } } }
```

## Why it is not just logging

Everyone is building agent *observability* — dashboards you have to take on
faith. Vouchwell builds agent **evidence**: a record whose integrity a third
party can check independently, using nothing but the file you hand them.

- **Signed** — Ed25519 over an RFC 8785 canonical form.
- **Chained** — each receipt commits to its predecessor's hash.
- **Tree-anchored** — RFC 6962 Merkle log, the construction Certificate
  Transparency uses. Verified against the published CT reference vectors.
- **Sealed** — arguments are salted commitments, not payloads. Destroy the
  salts and those payloads become permanently unopenable while every proof
  still verifies. Receipts also carry a redacted preview, which is signed and
  so stays; set `"previews": "none"` where arguments hold personal data.

## Commands

```
vw demo                    see it work: an agent session, then four attacks on its log
vw init                    create a log, a starter policy, and a config
vw proxy -- <cmd...>       wrap an MCP server; enforce policy, write receipts
vw hook install            gate a coding agent's own tools: Claude Code, Codex, Cursor
vw policy template <id...> start from ready-made policies: secrets, shell, SQL, payments…
vw log / vw stats / vw dash        inspect
vw mcp                     serve the log to agents as a read-only MCP server
vw verify                  audit the local log end to end
vw prove <seq>             inclusion proof for one receipt
vw export / vw check       evidence bundle for a third party, and verify one
vw remote add / vw push    connect to a hub and ship receipts
vw cosign                  have an independent witness counter-sign your root
vw shred --before <date>   destroy payload commitments, keep the audit trail
```

`vw verify` exits non-zero when a log has been altered — put it in CI.

## What it does not do

- **It cannot prove an action it never saw.** An agent with a second,
  unwrapped path to the same API leaves no receipt.
- **The cryptography has not been reviewed by anyone independent.** It is
  pinned to published RFC 6962 and RFC 8032 vectors rather than only to
  itself, but that is not the same thing.

Full threat model: https://github.com/vouchwell/vouchwell/blob/main/docs/THREAT-MODEL.md

## Part of Vouchwell

| Package | What it is |
| --- | --- |
| [`vouchwell`](https://npmjs.com/package/vouchwell) | The `vw` CLI — start here |
| [`@vouchwell/core`](https://npmjs.com/package/@vouchwell/core) | Receipts, Merkle log, policy engine. Zero dependencies. |
| [`@vouchwell/proxy`](https://npmjs.com/package/@vouchwell/proxy) | The MCP proxy and the hub client |
| [`@vouchwell/server`](https://npmjs.com/package/@vouchwell/server) | The multi-tenant hub |
| [`@vouchwell/dashboard`](https://npmjs.com/package/@vouchwell/dashboard) | Local read-only dashboard |

Website, with an in-browser verifier: **https://vouchwell.axonscape.com** ·
full documentation: **https://github.com/vouchwell/vouchwell**

Apache-2.0. The format, the verifier and the CLI are open and stay open:
evidence you cannot verify without a vendor's permission is not evidence.

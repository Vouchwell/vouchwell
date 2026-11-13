#!/usr/bin/env node
// A minimal MCP stdio server for the tests, scripts and CI. It lives in the
// CLI package, as the server `vw demo` wraps, so the demo works from an
// install; importing it here runs it.
import '../packages/cli/src/demo-server.js';

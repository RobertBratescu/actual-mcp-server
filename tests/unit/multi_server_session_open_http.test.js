// tests/unit/multi_server_session_open_http.test.js  (#571, path 1 wiring)
//
// multi_server_budget_selection.test.js proves that a session opened on a budget from another
// server logs in THERE, but it opens sessions with its own helper. This file drives the REAL
// onsessioninitialized in src/server/httpServer.ts, so a regression in that block (going back to
// connectToActualForSession(sid) with no budget, which opened every session on the default
// server) turns it red.
//
// The real HTTP server runs in a CHILD process (config.ts parses env once), with static bearer
// auth (principal 'static-bearer') and connectionPool.getConnection stubbed to record the budget
// it was asked to open.
//
// Scenarios:
//   S-restored  the principal has a stored #189 preference for Gamma on server Y: the session
//               opens on Gamma, on Y, with Gamma's password.
//   S-default   (negative) no stored preference: the session opens on the default budget and
//               server, never on the other server's credentials.
//
// Mutation check (manual, recorded in the #571 commit): M9, reverting the call to
// connectToActualForSession(sid), turns S-restored red.
//
// Run: node tests/unit/multi_server_session_open_http.test.js

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SENTINEL = '__SESSION_OPEN_571__ ';
const TOKEN = 'open-571-token';

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok: ${label}`); passed++; }
  catch (err) { console.error(`  FAIL: ${label} -> ${err.message}`); failed++; }
}

const CHILD = `
const { connectionPool } = await import('./dist/src/lib/ActualConnectionPool.js');
const opened = [];
connectionPool.getConnection = async (sid, budget) => {
  opened.push(budget ?? null);
  connectionPool.connections.set(sid, {
    sessionId: sid, initialized: true, lastActivity: Date.now(),
    dataDir: '/nonexistent', serverUrl: 'http://x:5006', password: 'pw-x', syncId: 'alpha-sync',
  });
};
const adapterMod = await import('./dist/src/lib/actual-adapter.js');
adapterMod._setSkipApiInitForTests(true);
const { setPreferredBudgetSyncId } = await import('./dist/src/lib/budget-preference-store.js');
const { startHttpServer } = await import('./dist/src/server/httpServer.js');
const mcp = { executeTool: async () => ({ ok: true }) };
const { listener, cleanup } = await startHttpServer(mcp, 0, '/http', {}, ['actual_accounts_list'], 'desc', 'instr', {}, 'test', '127.0.0.1', undefined);
if (!listener.listening) await new Promise((res, rej) => { listener.once('listening', res); listener.once('error', rej); });
const base = 'http://127.0.0.1:' + listener.address().port + '/http';
const open = async () => {
  const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + process.env.MCP_SSE_AUTHORIZATION },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'open-571', version: '0' } } }) });
  await r.text();
  return { status: r.status, sid: r.headers.get('mcp-session-id') };
};
const results = {};
results.defaultOpen = await open();
results.defaultBudget = opened.at(-1);
setPreferredBudgetSyncId('static-bearer', 'gamma-sync');
results.restoredOpen = await open();
results.restoredBudget = opened.at(-1);
await new Promise((res) => listener.close(res));
process.removeListener('SIGTERM', cleanup); process.removeListener('SIGINT', cleanup);
process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(results) + '\\n');
process.exit(0);
`;

const env = {
  ...process.env,
  ACTUAL_SERVER_URL: 'http://x:5006',
  ACTUAL_PASSWORD: 'pw-x',
  ACTUAL_BUDGET_SYNC_ID: 'alpha-sync',
  BUDGET_DEFAULT_NAME: 'Alpha',
  BUDGET_1_NAME: 'Gamma',
  BUDGET_1_SYNC_ID: 'gamma-sync',
  BUDGET_1_SERVER_URL: 'http://y:5006',
  BUDGET_1_PASSWORD: 'pw-gamma',
  MCP_SSE_AUTHORIZATION: TOKEN,
  AUTH_PROVIDER: 'none',
  AUTH_BUDGET_ACL: undefined,
  MCP_ALLOW_UNAUTHENTICATED: undefined,
  USE_CONNECTION_POOL: undefined,
  NODE_ENV: 'production',
};
const dataDir = mkdtempSync(join(tmpdir(), 'session-open-571-'));
env.MCP_BRIDGE_DATA_DIR = dataDir;
for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
rmSync(dataDir, { recursive: true, force: true });

console.log('\n[#571 session open] the real onsessioninitialized opens the session on its own budget');
let r = null;
check('the child ran to completion', () => {
  assert.strictEqual(child.signal, null, 'child hung');
  assert.strictEqual(child.status, 0, `child exited ${child.status}\n${(child.stderr || '').slice(-2000)}\n${(child.stdout || '').slice(-2000)}`);
  const lines = (child.stdout || '').split('\n').filter((l) => l.startsWith(SENTINEL));
  assert.strictEqual(lines.length, 1, 'expected one sentinel line');
  r = JSON.parse(lines[0].slice(SENTINEL.length));
});

if (r) {
  check('S-restored a stored preference for Gamma opens the session on Gamma, on server Y, with Gamma\'s password', () => {
    assert.strictEqual(r.restoredOpen.status, 200);
    assert.ok(r.restoredOpen.sid, 'a session id was issued');
    assert.ok(r.restoredBudget, 'getConnection received a budget (null means the default-server open of the bug)');
    assert.deepStrictEqual(
      { serverUrl: r.restoredBudget.serverUrl, password: r.restoredBudget.password, syncId: r.restoredBudget.syncId },
      { serverUrl: 'http://y:5006', password: 'pw-gamma', syncId: 'gamma-sync' });
  });
  check('S-default (negative) with no stored preference the session opens on the default budget and server', () => {
    assert.strictEqual(r.defaultOpen.status, 200);
    assert.ok(r.defaultBudget, 'getConnection received a budget');
    assert.deepStrictEqual(
      { serverUrl: r.defaultBudget.serverUrl, password: r.defaultBudget.password, syncId: r.defaultBudget.syncId },
      { serverUrl: 'http://x:5006', password: 'pw-x', syncId: 'alpha-sync' });
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// tests/unit/session_budget_state_cleanup.test.js  (#564)
//
// A session's selected budget (the adapter's per-session map) must be released on
// EVERY session end, not only by actual_session_close. teardownSession in
// src/server/httpServer.ts is the one chokepoint every end passes through (idle
// eviction, the #530 orphan sweep, HTTP actual_session_close through the evict
// listener, and the #563 client DELETE), so the release lives there.
//
// The real HTTP server runs in a CHILD process (config.ts parses env once), with
// authentication disabled and a stubbed connectionPool.getConnection, like the
// pool_orphan_sweep harness. Budgets are selected with the real switchBudget on its
// same-auth fast path (no Actual server needed). The witness is
// _getActiveBudgetConfigForTests under the session's id: a selected budget resolves
// to its syncId, a released one falls back to the default.
//
// Scenarios:
//   S-idle    a session with a selected budget is evicted by the idle sweep: released.
//   S-orphan  a session whose pool entry was dropped is reaped by the orphan sweep: released.
//   S-other   while one session is evicted, another keeps its selection.
//   S-switch  (negative) a switch keeps the new selection; switching never releases it.
//   S-late    a selection committed AFTER the session was torn down (a switch that was
//             in flight across the teardown) is not recorded.
//   S-restore the #189 preference restore memoizes into a live session (positive) but
//             not into a torn-down one (negative): the dead session follows the store.
//   S-one     the map has exactly one write site, the liveness-checked helper, so the
//             restore and all three switch commits are covered by S-late's guard.
//
// Mutation check (manual, recorded in the #564 commit): removing the
// clearSessionBudgetState call from teardownSession turns S-idle and S-orphan red;
// removing the liveness check from the commit helper turns S-late and S-restore
// (negative) red.
//
// Run: node tests/unit/session_budget_state_cleanup.test.js

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SENTINEL = '__BUDGET_STATE_RESULT__ ';

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok: ${label}`); passed++; }
  catch (err) { console.error(`  FAIL: ${label} -> ${err.message}`); failed++; }
}

console.log('\n[session-budget-state] teardown releases the selected budget (child process, auth disabled)');

const CHILD = `
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const step = (ms) => { offset += ms; };

const { connectionPool } = await import('./dist/src/lib/ActualConnectionPool.js');
const IDLE = connectionPool.getIdleTimeoutMinutes() * 60 * 1000;
connectionPool.getConnection = async (sid) => {
  connectionPool.connections.set(sid, {
    sessionId: sid, initialized: true, lastActivity: Date.now(),
    dataDir: '/nonexistent', serverUrl: 'http://localhost:5006', password: 'x', syncId: 'sync-default',
  });
  return connectionPool.connections.get(sid);
};
const adapterMod = await import('./dist/src/lib/actual-adapter.js');
adapterMod._setSkipApiInitForTests(true);
const { requestContext } = await import('./dist/src/lib/requestContext.js');
const inSession = (sid, fn) => requestContext.run({ sessionId: sid }, fn);
const selected = (sid) => inSession(sid, () => adapterMod._getActiveBudgetConfigForTests().syncId);
const select = (sid, name) => inSession(sid, () => adapterMod.switchBudget(name));

const mcp = { executeTool: async () => ({ ok: true }) };
const { startHttpServer } = await import('./dist/src/server/httpServer.js');
const { listener, cleanup } = await startHttpServer(mcp, 0, '/http', {}, ['actual_accounts_list'], 'desc', 'instr', {}, 'test', '127.0.0.1', undefined);
if (!listener.listening) await new Promise((res, rej) => { listener.once('listening', res); listener.once('error', rej); });
const base = 'http://127.0.0.1:' + listener.address().port + '/http';
const initBody = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'budget-state-test', version: '0' } } };
const open = async () => {
  const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(initBody) });
  await r.text();
  return r.headers.get('mcp-session-id');
};
const sweep = () => connectionPool.cleanupIdleConnections();
const results = {};

// S-idle and S-other: two sessions select budgets; only the idle one is evicted.
const sidIdle = await open();
const sidOther = await open();
await select(sidIdle, 'Production');
results.idleBefore = selected(sidIdle);
step(IDLE / 2 + 1000);
await select(sidOther, 'Personal'); // refreshes sidOther's lastActivity via the new pool clock
connectionPool.connections.get(sidOther).lastActivity = Date.now();
step(IDLE / 2 + 1000);
await sweep();
results.idleRegistered = connectionPool.registered.has(sidIdle);
results.idleAfter = selected(sidIdle);
results.otherRegistered = connectionPool.registered.has(sidOther);
results.otherAfter = selected(sidOther);

// S-switch (negative): switching again keeps the new selection.
await select(sidOther, 'Production');
results.otherSwitched = selected(sidOther);

// S-orphan: the entry is dropped without eviction, then the orphan sweep reaps it.
const sidOrphan = await open();
await select(sidOrphan, 'Production');
results.orphanBefore = selected(sidOrphan);
connectionPool.connections.delete(sidOrphan);
step(IDLE + 1000);
await sweep();
results.orphanRegistered = connectionPool.registered.has(sidOrphan);
results.orphanAfter = selected(sidOrphan);

// S-late: a selection committed after the teardown is not recorded.
const sidLate = await open();
step(IDLE + 1000);
await sweep();
results.lateRegistered = connectionPool.registered.has(sidLate);
connectionPool.connections.set(sidLate, {
  sessionId: sidLate, initialized: true, lastActivity: Date.now(),
  dataDir: '/nonexistent', serverUrl: 'http://localhost:5006', password: 'x', syncId: 'sync-default',
});
let lateError = null;
try { await select(sidLate, 'Production'); } catch (e) { lateError = String(e && e.message); }
connectionPool.connections.delete(sidLate);
results.lateError = lateError;
results.lateAfter = selected(sidLate);

// S-restore: the principal's persisted preference is restored in both sessions, but
// memoized only into the live one. Moving the preference afterwards shows which.
const pref = await import('./dist/src/lib/budget-preference-store.js');
const asP = (sid) => requestContext.run({ sessionId: sid, principal: 'p-564' }, () => adapterMod._getActiveBudgetConfigForTests().syncId);
const sidLive = await open();
pref.setPreferredBudgetSyncId('p-564', 'sync-personal');
results.restoreLive = asP(sidLive);
results.restoreDead = asP(sidLate);
pref.setPreferredBudgetSyncId('p-564', 'sync-prod');
results.restoreLiveAfterMove = asP(sidLive);
results.restoreDeadAfterMove = asP(sidLate);

await new Promise((res) => listener.close(res));
process.removeListener('SIGTERM', cleanup); process.removeListener('SIGINT', cleanup);
process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(results) + '\\n');
process.exit(0);
`;

const env = {
  ...process.env,
  ACTUAL_SERVER_URL: 'http://localhost:5006',
  ACTUAL_PASSWORD: 'x',
  ACTUAL_BUDGET_SYNC_ID: 'sync-default',
  BUDGET_1_NAME: 'Production',
  BUDGET_1_SYNC_ID: 'sync-prod',
  BUDGET_1_SERVER_URL: 'http://localhost:5006',
  BUDGET_1_PASSWORD: 'x',
  BUDGET_2_NAME: 'Personal',
  BUDGET_2_SYNC_ID: 'sync-personal',
  BUDGET_2_SERVER_URL: 'http://localhost:5006',
  BUDGET_2_PASSWORD: 'x',
  AUTH_PROVIDER: 'none',
  MCP_ALLOW_UNAUTHENTICATED: 'true',
  MCP_SSE_AUTHORIZATION: undefined,
  AUTH_BUDGET_ACL: undefined,
  USE_CONNECTION_POOL: undefined,
  SESSION_IDLE_TIMEOUT_MINUTES: '1',
  NODE_ENV: 'production',
};
const DATA_DIR = mkdtempSync(join(tmpdir(), 'budget-state-564-'));
env.MCP_BRIDGE_DATA_DIR = DATA_DIR;
for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
rmSync(DATA_DIR, { recursive: true, force: true });
const resultLines = (child.stdout || '').split('\n').filter((l) => l.startsWith(SENTINEL));
assert.strictEqual(child.signal, null, 'child hung');
assert.strictEqual(child.status, 0, `child exited ${child.status}\n${(child.stderr || '').slice(-2000)}\n${(child.stdout || '').slice(-2000)}`);
assert.strictEqual(resultLines.length, 1, 'expected one sentinel line');
const r = JSON.parse(resultLines[0].slice(SENTINEL.length));

check('S-idle a selected budget is in effect before the eviction', () => assert.strictEqual(r.idleBefore, 'sync-prod'));
check('S-idle the idle sweep evicts the session and releases its selection', () => {
  assert.strictEqual(r.idleRegistered, false, 'evicted');
  assert.strictEqual(r.idleAfter, 'sync-default', 'released to the default');
});
check('S-other the session that was not evicted keeps its selection', () => {
  assert.strictEqual(r.otherRegistered, true);
  assert.strictEqual(r.otherAfter, 'sync-personal');
});
check('S-switch (negative) a further switch keeps the new selection', () => assert.strictEqual(r.otherSwitched, 'sync-prod'));
check('S-orphan the orphan sweep reaps an entry-less session and releases its selection', () => {
  assert.strictEqual(r.orphanBefore, 'sync-prod');
  assert.strictEqual(r.orphanRegistered, false, 'reaped');
  assert.strictEqual(r.orphanAfter, 'sync-default');
});
check('S-late a selection committed after teardown is not recorded, and the switch does not throw', () => {
  assert.strictEqual(r.lateRegistered, false, 'torn down first');
  assert.strictEqual(r.lateError, null, `switch threw: ${r.lateError}`);
  assert.strictEqual(r.lateAfter, 'sync-default');
});

check('S-restore (positive) a live session memoizes the restored preference', () => {
  assert.strictEqual(r.restoreLive, 'sync-personal');
  assert.strictEqual(r.restoreLiveAfterMove, 'sync-personal', 'memoized: unaffected by the later preference move');
});
check('S-restore (negative) a torn-down session is restored but never memoized', () => {
  assert.strictEqual(r.restoreDead, 'sync-personal');
  assert.strictEqual(r.restoreDeadAfterMove, 'sync-prod', 'not memoized: follows the store');
});
check('S-one the map is written in exactly one place, the liveness-checked helper', () => {
  const src = readFileSync(join(ROOT, 'src', 'lib', 'actual-adapter.ts'), 'utf8');
  assert.strictEqual(src.split('sessionBudgetState.set(').length - 1, 1, 'one write site');
  const helper = src.slice(src.indexOf('function setSessionBudget('), src.indexOf('\n}\n', src.indexOf('function setSessionBudget(')));
  assert.ok(helper.includes('if (!isSessionLive(sessionId))') && helper.includes('sessionBudgetState.set('), 'the write is inside the checked helper');
});

console.log(`\n[session-budget-state] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

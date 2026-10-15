// tests/unit/http_session_delete.test.js  (#563)
//
// A client ends its session with HTTP DELETE on the MCP path (MCP spec 2025-11-25,
// Session Management rule 5). The route lives in src/server/httpServer.ts: same auth
// gate, missing-id answer and ownership rule as POST, then the SDK validates the
// protocol version and answers 200, and only then does the server tear the session
// down (teardownSession, reason `closed`) and shut its pool entry down.
//
// The real HTTP server runs in a CHILD process (config.ts parses env once). Two runs:
//   POOL  static bearer auth, stubbed connectionPool.getConnection (like the
//         session_budget_state_cleanup harness).
//   NOPOOL USE_CONNECTION_POOL=false, auth disabled, the @actual-app/api object stubbed
//         (init, getServerVersion, downloadBudget, getBudgetMonths) so the shared
//         connection opens without an Actual server. The pool eviction listener never
//         fires in this mode, which is why the route tears down directly.
//
// Scenarios:
//   S-close    the owner's DELETE answers 200; the next POST on that id answers 404 -32001;
//              transport, owner, registration and budget selection are all released, and
//              the log names the reason `closed`.
//   S-dropped  a session whose pool entry was already dropped (#530) is still torn down.
//   S-missing  (negative) DELETE without Mcp-Session-Id answers 400 -32000.
//   S-unknown  (negative) an unknown id answers 404 -32001; a non-owner gets the same
//              bytes and the owner's session survives.
//   S-version  (negative) an unsupported MCP-Protocol-Version answers 400 and the session
//              survives (teardown only after a 200).
//   S-auth     (negative) DELETE without the bearer answers 401; the session survives.
//   S-inflight another session's call that holds the api lock when the DELETE arrives
//              finishes before the pool shutdown runs, the 200 only arrives once the pool
//              slot is free, and the other session's next call still succeeds.
//   S-method   PUT and PATCH answer 405 JSON with Allow: GET, POST, DELETE.
//   S-queued   a write queued while its session was live runs; one whose session ended
//              before the drain (its budget selection already released) is refused rather
//              than run on the default budget.
//   S-nopool   with the pool disabled the DELETE still releases the transport and the
//              budget selection.
//
// Mutation check (manual, recorded in the #563 commit): removing the direct
// teardownSession call turns S-close, S-dropped and S-nopool red; removing the ownership
// check turns S-unknown red; moving the pool shutdown after the 200 turns S-inflight red; removing the drain's
// first liveness check turns the first S-queued negative red, and removing the re-check before
// the operation turns the second red.
//
// Run: node tests/unit/http_session_delete.test.js

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SENTINEL = '__SESSION_DELETE_RESULT__ ';
const TOKEN = 'delete-test-token';

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok: ${label}`); passed++; }
  catch (err) { console.error(`  FAIL: ${label} -> ${err.message}`); failed++; }
}

// Shared by both children: start the server, open sessions, call tools, DELETE.
const HARNESS = `
const mcpCalls = [];
let holdNext = null;
const mcp = { executeTool: async (name) => {
  mcpCalls.push(name);
  if (holdNext) { const h = holdNext; holdNext = null; await h(); }
  return { ok: true };
} };
const adapterMod = await import('./dist/src/lib/actual-adapter.js');
adapterMod._setSkipApiInitForTests(true);
const { requestContext } = await import('./dist/src/lib/requestContext.js');
const owners = await import('./dist/src/lib/session-owners.js');
const selected = (sid) => requestContext.run({ sessionId: sid }, () => adapterMod._getActiveBudgetConfigForTests().syncId);
const select = (sid, name) => requestContext.run({ sessionId: sid }, () => adapterMod.switchBudget(name));
const { startHttpServer } = await import('./dist/src/server/httpServer.js');
const { listener, cleanup } = await startHttpServer(mcp, 0, '/http', {}, ['actual_accounts_list'], 'desc', 'instr', {}, 'test', '127.0.0.1', undefined);
if (!listener.listening) await new Promise((res, rej) => { listener.once('listening', res); listener.once('error', rej); });
const base = 'http://127.0.0.1:' + listener.address().port + '/http';
const AUTH = process.env.MCP_SSE_AUTHORIZATION ? { Authorization: 'Bearer ' + process.env.MCP_SSE_AUTHORIZATION } : {};
const H = (extra = {}) => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...AUTH, ...extra });
const open = async () => {
  const r = await fetch(base, { method: 'POST', headers: H(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'delete-test', version: '0' } } }) });
  await r.text();
  return r.headers.get('mcp-session-id');
};
const call = async (sid) => {
  const r = await fetch(base, { method: 'POST', headers: H({ 'mcp-session-id': sid }), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'actual_accounts_list', arguments: {} } }) });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const del = async (sid, extra = {}, auth = true) => {
  const headers = { ...(auth ? AUTH : {}), ...(sid ? { 'mcp-session-id': sid } : {}), ...extra };
  const r = await fetch(base, { method: 'DELETE', headers });
  return { status: r.status, text: await r.text(), allow: r.headers.get('allow') };
};
const results = {};
`;

const TAIL = `
await new Promise((res) => listener.close(res));
process.removeListener('SIGTERM', cleanup); process.removeListener('SIGINT', cleanup);
process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(results) + '\\n');
process.exit(0);
`;

const POOL_CHILD = `
const { connectionPool } = await import('./dist/src/lib/ActualConnectionPool.js');
connectionPool.getConnection = async (sid) => {
  connectionPool.connections.set(sid, {
    sessionId: sid, initialized: true, lastActivity: Date.now(),
    dataDir: '/nonexistent', serverUrl: 'http://localhost:5006', password: 'x', syncId: 'sync-default',
  });
  return connectionPool.connections.get(sid);
};
const events = [];
const realLocked = connectionPool.shutdownConnectionLocked.bind(connectionPool);
connectionPool.shutdownConnectionLocked = async (sid, opts) => { events.push('shutdown:' + sid.slice(0, 8)); return realLocked(sid, opts); };
const { withApiLock } = await import('./dist/src/lib/apiLock.js');
${HARNESS}

// S-close
const sidA = await open();
await select(sidA, 'Production');
results.closeSelectedBefore = selected(sidA);
results.closeCallBefore = (await call(sidA)).status;
const dA = await del(sidA);
results.closeStatus = dA.status;
const after = await call(sidA);
results.closeNextStatus = after.status;
results.closeNextCode = after.body && after.body.error && after.body.error.code;
results.closeRegistered = connectionPool.registered.has(sidA);
results.closeEntry = connectionPool.connections.has(sidA);
results.closeOwner = owners.sessionOwnerMatches(sidA, 'static-bearer');
results.closeSelectedAfter = selected(sidA);
results.closeShutdown = events.includes('shutdown:' + sidA.slice(0, 8));

// S-dropped
const sidD = await open();
connectionPool.connections.delete(sidD);
const dD = await del(sidD);
results.droppedStatus = dD.status;
results.droppedRegistered = connectionPool.registered.has(sidD);
results.droppedNext = (await call(sidD)).status;

// S-missing
const dM = await del(null);
results.missingStatus = dM.status;
results.missingBody = dM.text;

// S-unknown and the non-owner
const sidO = await open();
const dU = await del('00000000-0000-4000-8000-000000000000');
results.unknownStatus = dU.status;
results.unknownBody = dU.text;
owners.recordSessionOwner(sidO, 'someone-else');
const dN = await del(sidO);
results.nonOwnerStatus = dN.status;
results.nonOwnerBody = dN.text;
owners.recordSessionOwner(sidO, 'static-bearer');
results.nonOwnerSurvives = (await call(sidO)).status;

// S-version
const dV = await del(sidO, { 'mcp-protocol-version': '1999-01-01' });
results.versionStatus = dV.status;
results.versionSurvives = (await call(sidO)).status;

// S-auth
const dX = await del(sidO, {}, false);
results.authStatus = dX.status;
results.authSurvives = (await call(sidO)).status;

// S-inflight: sidB's call holds the api lock when sidO's DELETE arrives.
const sidB = await open();
let release;
const held = new Promise((r) => { release = r; });
let entered;
const inLock = new Promise((r) => { entered = r; });
holdNext = () => withApiLock(async () => { entered(); events.push('b:start'); await held; events.push('b:end'); });
const bCall = call(sidB);
await inLock;
const dI = del(sidO).then((x) => { events.push('del:200'); return x; });
await new Promise((r) => setTimeout(r, 200));
release();
const [bRes, dIRes] = await Promise.all([bCall, dI]);
results.inflightB = bRes.status;
results.inflightBError = bRes.body && bRes.body.result && bRes.body.result.isError;
results.inflightDelete = dIRes.status;
const iEnd = events.indexOf('b:end');
const iShut = events.indexOf('shutdown:' + sidO.slice(0, 8));
results.inflightOrder = iEnd >= 0 && iShut > iEnd;
results.inflightSlotFreedFirst = iShut >= 0 && events.indexOf('del:200') > iShut;
results.inflightBNext = (await call(sidB)).status;

// S-method
for (const m of ['PUT', 'PATCH']) {
  const r = await fetch(base, { method: m, headers: H({ 'mcp-session-id': sidB }), body: '{}' });
  results['method' + m] = { status: r.status, allow: r.headers.get('allow'), text: await r.text() };
}

// S-queued: a write queued while the session is live, whose session ends inside the drain's
// debounce window. Last, because it replaces the server's liveness check with a switch the
// test controls (a real DELETE's timing against the 100ms window is not deterministic).
const apiDefault = (await import('@actual-app/api')).default;
apiDefault.sync = async () => undefined;
let alive = true;
adapterMod.setSessionLivenessCheck(() => alive);
const sidW = await open();
await select(sidW, 'Production');
const queued = (ran) => requestContext.run({ sessionId: sidW }, () => adapterMod.withWriteSession(async () => { ran.push(true); return 'written'; }));
const ranLive = [];
results.queuedLive = await queued(ranLive).then((v) => v, (e) => 'rejected: ' + e.message);
results.queuedLiveRan = ranLive.length;
const ranEnded = [];
const pending = queued(ranEnded).then((v) => v, (e) => 'rejected: ' + e.message);
alive = false;
results.queuedEnded = await pending;
results.queuedEndedRan = ranEnded.length;
// The session ends AFTER the drain's first check but before the op runs (the window the
// drain's awaits open, see #563 round 3): the first liveness read says live, every later one dead.
let reads = 0;
adapterMod.setSessionLivenessCheck(() => (reads++ === 0));
const ranLate = [];
results.queuedLate = await queued(ranLate).then((v) => v, (e) => 'rejected: ' + e.message);
results.queuedLateRan = ranLate.length;
${TAIL}`;

const NOPOOL_CHILD = `
const apiMod = await import('@actual-app/api');
const api = apiMod.default || apiMod;
api.init = async () => undefined;
api.getServerVersion = async () => ({ version: '26.0.0' });
api.downloadBudget = async () => undefined;
api.getBudgetMonths = async () => ['2026-10'];
${HARNESS}
const sid = await open();
await select(sid, 'Production');
results.selectedBefore = selected(sid);
results.callBefore = (await call(sid)).status;
const d = await del(sid);
results.status = d.status;
results.next = (await call(sid)).status;
results.selectedAfter = selected(sid);
${TAIL}`;

function runChild(script, extraEnv) {
  const env = {
    ...process.env,
    ACTUAL_SERVER_URL: 'http://localhost:5006',
    ACTUAL_PASSWORD: 'x',
    ACTUAL_BUDGET_SYNC_ID: 'sync-default',
    BUDGET_1_NAME: 'Production',
    BUDGET_1_SYNC_ID: 'sync-prod',
    BUDGET_1_SERVER_URL: 'http://localhost:5006',
    BUDGET_1_PASSWORD: 'x',
    AUTH_PROVIDER: 'none',
    AUTH_BUDGET_ACL: undefined,
    MCP_SSE_AUTHORIZATION: undefined,
    MCP_ALLOW_UNAUTHENTICATED: undefined,
    USE_CONNECTION_POOL: undefined,
    NODE_ENV: 'production',
    ...extraEnv,
  };
  const dataDir = mkdtempSync(join(tmpdir(), 'session-delete-563-'));
  env.MCP_BRIDGE_DATA_DIR = dataDir;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  rmSync(dataDir, { recursive: true, force: true });
  assert.strictEqual(child.signal, null, 'child hung');
  assert.strictEqual(child.status, 0, `child exited ${child.status}\n${(child.stderr || '').slice(-2000)}\n${(child.stdout || '').slice(-2000)}`);
  const lines = (child.stdout || '').split('\n').filter((l) => l.startsWith(SENTINEL));
  assert.strictEqual(lines.length, 1, 'expected one sentinel line');
  return { r: JSON.parse(lines[0].slice(SENTINEL.length)), log: (child.stdout || '') + (child.stderr || '') };
}

console.log('\n[session-delete] DELETE ends an HTTP session (pool enabled, static bearer)');
const { r, log } = runChild(POOL_CHILD, { MCP_SSE_AUTHORIZATION: TOKEN });

const NOT_FOUND = '{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Session not found. Please re-initialize by calling initialize without mcp-session-id header."}}';

check('S-close the owner\'s DELETE answers 200 and the next call on the id answers 404 -32001', () => {
  assert.strictEqual(r.closeCallBefore, 200);
  assert.strictEqual(r.closeStatus, 200);
  assert.strictEqual(r.closeNextStatus, 404);
  assert.strictEqual(r.closeNextCode, -32001);
});
check('S-close transport, owner, registration, pool entry and budget selection are released', () => {
  assert.strictEqual(r.closeSelectedBefore, 'sync-prod');
  assert.strictEqual(r.closeRegistered, false, 'registered');
  assert.strictEqual(r.closeEntry, false, 'pool entry');
  assert.strictEqual(r.closeOwner, false, 'owner');
  assert.strictEqual(r.closeSelectedAfter, 'sync-default', 'budget selection');
  assert.strictEqual(r.closeShutdown, true, 'pool shutdown ran');
});
check('S-close the teardown is logged with the reason closed', () => {
  assert.ok(/Transport torn down for closed session/.test(log), 'no closed teardown line');
});
check('S-dropped a session whose pool entry was dropped is still torn down', () => {
  assert.strictEqual(r.droppedStatus, 200);
  assert.strictEqual(r.droppedRegistered, false);
  assert.strictEqual(r.droppedNext, 404);
});
check('S-missing (negative) DELETE without Mcp-Session-Id answers 400 -32000', () => {
  assert.strictEqual(r.missingStatus, 400);
  assert.strictEqual(JSON.parse(r.missingBody).error.code, -32000);
});
check('S-unknown (negative) an unknown id answers 404 -32001', () => {
  assert.strictEqual(r.unknownStatus, 404);
  assert.strictEqual(r.unknownBody, NOT_FOUND);
});
check('S-unknown (negative) a non-owner gets the unknown-id bytes and the session survives', () => {
  assert.strictEqual(r.nonOwnerStatus, 404);
  assert.strictEqual(r.nonOwnerBody, r.unknownBody, 'byte-identical');
  assert.strictEqual(r.nonOwnerSurvives, 200);
});
check('S-version (negative) an unsupported protocol version answers 400 and the session survives', () => {
  assert.strictEqual(r.versionStatus, 400);
  assert.strictEqual(r.versionSurvives, 200);
});
check('S-auth (negative) DELETE without the bearer answers 401 and the session survives', () => {
  assert.strictEqual(r.authStatus, 401);
  assert.strictEqual(r.authSurvives, 200);
});
check('S-inflight another session\'s call in the api lock finishes first, and its next call succeeds', () => {
  assert.strictEqual(r.inflightB, 200);
  assert.ok(!r.inflightBError, 'call B returned an error result');
  assert.strictEqual(r.inflightDelete, 200);
  assert.strictEqual(r.inflightOrder, true, 'pool shutdown ran before call B released the lock');
  assert.strictEqual(r.inflightSlotFreedFirst, true, 'the 200 arrived before the pool slot was freed');
  assert.strictEqual(r.inflightBNext, 200);
});
check('S-method PUT and PATCH answer 405 JSON with the Allow header', () => {
  for (const m of ['PUT', 'PATCH']) {
    const x = r['method' + m];
    assert.strictEqual(x.status, 405, m);
    assert.strictEqual(x.allow, 'GET, POST, DELETE', m);
    assert.strictEqual(JSON.parse(x.text).error.code, -32000, m);
  }
});

check('S-queued a write queued in a live session runs (positive)', () => {
  assert.strictEqual(r.queuedLive, 'written');
  assert.strictEqual(r.queuedLiveRan, 1);
});
check('S-queued (negative) a write whose session ended before the drain is refused, never run on the default budget', () => {
  assert.ok(/^rejected: The session ended before this write ran/.test(r.queuedEnded), r.queuedEnded);
  assert.strictEqual(r.queuedEndedRan, 0, 'the operation ran');
});
check('S-queued (negative) a session that ends after the drain picked the write up is re-checked before it runs', () => {
  assert.ok(/^rejected: The session ended before this write ran/.test(r.queuedLate), r.queuedLate);
  assert.strictEqual(r.queuedLateRan, 0, 'the operation ran');
});

console.log('\n[session-delete] DELETE with the connection pool disabled');
const np = runChild(NOPOOL_CHILD, { USE_CONNECTION_POOL: 'false', MCP_ALLOW_UNAUTHENTICATED: 'true' }).r;
// No auth means the principal is undefined, so the owner record is not observable here;
// the pool run covers it.
check('S-nopool DELETE releases the transport and the budget selection', () => {
  assert.strictEqual(np.selectedBefore, 'sync-prod');
  assert.strictEqual(np.callBefore, 200);
  assert.strictEqual(np.status, 200);
  assert.strictEqual(np.next, 404);
  assert.strictEqual(np.selectedAfter, 'sync-default', 'budget selection');
});

console.log(`\n[session-delete] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

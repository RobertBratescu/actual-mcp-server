// tests/unit/session_admission_race.test.js  (#581)
//
// MAX_CONCURRENT_SESSIONS was checked against INITIALIZED pool entries only, and an entry is
// initialized only after its login and budget download finish. Every initialize that arrived while
// those were in flight saw the same count, so N parallel initializes all passed the 503 gate and
// all logged in, whatever the cap.
//
// This file drives the REAL initialize path in src/server/httpServer.ts in a CHILD process (config
// and the pool read env once), with MAX_CONCURRENT_SESSIONS=2 and connectionPool.getConnection
// stubbed to take a while before it creates the entry, the way a real login does.
//
// Scenarios:
//   S-parallel    6 initializes in the same tick: exactly 2 are admitted, 4 get the 503, and only
//                 2 logins start. Red before #581 (6 admitted, 6 logins).
//   S-failed      (negative) a login that rejects leaks no slot: two initializes after it are both
//                 admitted under a cap of 2.
//   S-sequential  (negative) two open sessions fill the cap, a third is refused, and once one of
//                 the two is closed with DELETE a third is admitted: ordinary use is unchanged.
//   S-rejected    (negative) a refused initialize leaks no slot either: after 4 refusals and both
//                 admitted sessions closed with DELETE, the cap still admits exactly 2.
//   S-unauth      (negative) an initialize with a bad bearer is answered 401 before it reserves:
//                 the reserve stays after authenticateRequest.
//   S-early       (negative) an initialize the SDK rejects before it reaches the pool (no jsonrpc
//                 field: the SDK answers 400 -32700) leaks no slot. Red when the route's finally
//                 release is removed. (A 406 is not reachable: the Accept middleware rewrites it.)
//   S-connect     (negative) an initialize whose server.connect throws leaks no slot. Red when the
//                 route's finally release is removed.
//   S-coherent    the 503 sent while two logins are still pending reports them: pendingReservations
//                 2 and availableSlots 0, and /health carries the count but no session id.
//
// Every row also asserts pendingReservations is back to 0 once its initializes have answered.
//
// Run: node tests/unit/session_admission_race.test.js

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SENTINEL = '__SESSION_ADMISSION_581__ ';
const TOKEN = 'admission-581-token';

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok: ${label}`); passed++; }
  catch (err) { console.error(`  FAIL: ${label} -> ${err.message}`); failed++; }
}

const CHILD = `
const { connectionPool } = await import('./dist/src/lib/ActualConnectionPool.js');
let logins = 0;
let mode = 'ok';
let delay = 150;
connectionPool.getConnection = async (sid) => {
  logins++;
  await new Promise((res) => setTimeout(res, delay));
  if (mode === 'reject') { connectionPool.releaseReservation?.(sid); throw new Error('login refused (stub)'); }
  // The real getConnection hands the reservation over to the entry in one synchronous block.
  connectionPool.connections.set(sid, {
    sessionId: sid, initialized: true, lastActivity: Date.now(),
    dataDir: '/nonexistent', serverUrl: 'http://x:5006', password: 'pw-x', syncId: 'alpha-sync',
  });
  connectionPool.releaseReservation?.(sid);
};
const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
const realConnect = Server.prototype.connect;
let connectThrows = 0;
Server.prototype.connect = async function (t) {
  if (connectThrows > 0) { connectThrows--; throw new Error('server.connect failed (stub)'); }
  return realConnect.call(this, t);
};
const adapterMod = await import('./dist/src/lib/actual-adapter.js');
adapterMod._setSkipApiInitForTests(true);
const { startHttpServer } = await import('./dist/src/server/httpServer.js');
const mcp = { executeTool: async () => ({ ok: true }) };
const { listener, cleanup } = await startHttpServer(mcp, 0, '/http', {}, ['actual_accounts_list'], 'desc', 'instr', {}, 'test', '127.0.0.1', undefined);
if (!listener.listening) await new Promise((res, rej) => { listener.once('listening', res); listener.once('error', rej); });
const base = 'http://127.0.0.1:' + listener.address().port + '/http';
const auth = { Authorization: 'Bearer ' + process.env.MCP_SSE_AUTHORIZATION };
const open = async (malformed = false) => {
  const msg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'admission-581', version: '0' } } };
  if (malformed) delete msg.jsonrpc;
  const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...auth },
    body: JSON.stringify(msg) });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, sid: r.headers.get('mcp-session-id'), body };
};
const close = async (sid) => {
  const r = await fetch(base, { method: 'DELETE', headers: { 'mcp-session-id': sid, ...auth } });
  await r.text();
  return r.status;
};
const pending = () => connectionPool.getStats().pendingReservations;
const reset = () => { connectionPool.connections.clear(); logins = 0; mode = 'ok'; delay = 150; };
const statuses = (rs) => rs.map((x) => x.status).sort();
const results = {};

reset();
const par = await Promise.all(Array.from({ length: 6 }, () => open()));
results.parallel = { statuses: statuses(par), logins, entries: connectionPool.connections.size, pending: pending() };

reset();
mode = 'reject';
const bad = await open();
mode = 'ok';
const after = [await open(), await open()];
results.failed = { bad: bad.status, after: statuses(after), logins, pending: pending() };

reset();
const first = await open();
const second = await open();
const third = await open();
const closed = await close(first.sid);
const fourth = await open();
results.sequential = { first: first.status, second: second.status, third: third.status, closed, fourth: fourth.status, pending: pending() };

reset();
const burst = await Promise.all(Array.from({ length: 6 }, () => open()));
for (const b of burst) if (b.status === 200) await close(b.sid);
const pendingBeforeRetry = pending();
const again = await Promise.all(Array.from({ length: 3 }, () => open()));
results.rejected = { again: statuses(again), pendingBeforeRetry, pending: pending() };

reset();
const badAuth = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer wrong-token' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'admission-581', version: '0' } } }) });
await badAuth.text();
results.unauth = { status: badAuth.status, pending: pending(), after: statuses([await open(), await open()]) };

reset();
const early = [await open(true), await open(true)];
const afterEarly = [await open(), await open()];
results.early = { early: early.map((x) => x.status), after: statuses(afterEarly), pending: pending() };

reset();
connectThrows = 2;
const thrown = [await open(), await open()];
const afterThrown = [await open(), await open()];
results.connect = { thrown: thrown.map((x) => x.status), after: statuses(afterThrown), pending: pending() };

reset();
delay = 600;
const slow = [open(), open()];
await new Promise((res) => setTimeout(res, 200));
const refused = await open();
const health = await (await fetch('http://127.0.0.1:' + listener.address().port + '/health')).text();
await Promise.all(slow);
results.coherent = { status: refused.status, error: refused.body && refused.body.error, health, pendingAfter: pending() };

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
  MAX_CONCURRENT_SESSIONS: '2',
  MCP_SSE_AUTHORIZATION: TOKEN,
  AUTH_PROVIDER: 'none',
  AUTH_BUDGET_ACL: undefined,
  MCP_ALLOW_UNAUTHENTICATED: undefined,
  USE_CONNECTION_POOL: undefined,
  NODE_ENV: 'production',
};
const dataDir = mkdtempSync(join(tmpdir(), 'session-admission-581-'));
env.MCP_BRIDGE_DATA_DIR = dataDir;
for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
rmSync(dataDir, { recursive: true, force: true });

console.log('\n[#581 session admission] MAX_CONCURRENT_SESSIONS holds under parallel initializes');
let r = null;
check('the child ran to completion', () => {
  assert.strictEqual(child.signal, null, 'child hung');
  assert.strictEqual(child.status, 0, `child exited ${child.status}\n${(child.stderr || '').slice(-2000)}\n${(child.stdout || '').slice(-2000)}`);
  const lines = (child.stdout || '').split('\n').filter((l) => l.startsWith(SENTINEL));
  assert.strictEqual(lines.length, 1, 'expected one sentinel line');
  r = JSON.parse(lines[0].slice(SENTINEL.length));
});

if (r) {
  check('S-parallel 6 initializes in one tick under a cap of 2: exactly 2 admitted, 4 refused with 503, 2 logins', () => {
    assert.deepStrictEqual(r.parallel.statuses, [200, 200, 503, 503, 503, 503]);
    assert.strictEqual(r.parallel.logins, 2, 'a refused initialize must never reach the login');
    assert.strictEqual(r.parallel.entries, 2);
  });
  check('S-failed (negative) a login that rejects leaks no slot: the next two initializes are both admitted', () => {
    assert.strictEqual(r.failed.bad, 200, 'the failing initialize itself is answered (its cause is reported on the next request, #438)');
    assert.deepStrictEqual(r.failed.after, [200, 200]);
    assert.strictEqual(r.failed.logins, 3);
  });
  check('S-sequential (negative) the cap refuses a third open session and admits one once a slot frees', () => {
    assert.deepStrictEqual(r.sequential, { first: 200, second: 200, third: 503, closed: 200, fourth: 200, pending: 0 });
  });
  check('S-rejected (negative) refused initializes leak no slot: the cap still admits exactly 2 afterwards', () => {
    assert.strictEqual(r.rejected.pendingBeforeRetry, 0);
    assert.deepStrictEqual(r.rejected.again, [200, 200, 503]);
  });
  check('S-unauth (negative) an initialize with a bad bearer is refused 401 before it reserves a slot', () => {
    assert.strictEqual(r.unauth.status, 401);
    assert.strictEqual(r.unauth.pending, 0);
    assert.deepStrictEqual(r.unauth.after, [200, 200]);
  });
  check('S-early (negative) initializes the SDK rejects before the pool leak no slot', () => {
    assert.deepStrictEqual(r.early.early, [400, 400]);
    assert.deepStrictEqual(r.early.after, [200, 200], 'an SDK-rejected initialize kept its reservation');
  });
  check('S-connect (negative) initializes whose server.connect throws leak no slot', () => {
    assert.ok(r.connect.thrown.every((st) => st >= 500), `expected server errors, got ${r.connect.thrown}`);
    assert.deepStrictEqual(r.connect.after, [200, 200], 'a failed server.connect kept its reservation');
  });
  check('S-coherent the 503 sent while 2 logins are pending reports pendingReservations 2 and availableSlots 0', () => {
    assert.strictEqual(r.coherent.status, 503);
    assert.strictEqual(r.coherent.error.code, -32000);
    assert.match(r.coherent.error.message, /^Max concurrent sessions \(2\) reached\. Active: 0\./);
    assert.strictEqual(r.coherent.error.data.pendingReservations, 2);
    assert.strictEqual(r.coherent.error.data.availableSlots, 0);
    assert.strictEqual(r.coherent.error.data.activeSessions, 0);
  });
  check('S-coherent /health reports the pending count and no session id', () => {
    const h = JSON.parse(r.coherent.health);
    assert.strictEqual(h.connectionPool.pendingReservations, 2);
    assert.doesNotMatch(r.coherent.health, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, '/health leaked a session id');
  });
  check('every row: no reservation is left once its initializes have answered', () => {
    for (const k of ['parallel', 'failed', 'sequential', 'rejected', 'unauth', 'early', 'connect']) {
      assert.strictEqual(r[k].pending, 0, `${k} left ${r[k].pending} reservation(s)`);
    }
    assert.strictEqual(r.coherent.pendingAfter, 0);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

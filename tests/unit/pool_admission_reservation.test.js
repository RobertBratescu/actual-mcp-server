// tests/unit/pool_admission_reservation.test.js  (#581)
//
// Pool-level half of the #581 admission tests. session_admission_race.test.js drives the HTTP
// route with getConnection stubbed; this file runs the REAL ActualConnectionPool.getConnection and
// switchBudget with only @actual-app/api stubbed (the http_session_delete.test.js pattern), so the
// reservation code inside them is what is under test. Each block runs in a CHILD process because
// config and the pool read MAX_CONCURRENT_SESSIONS / USE_CONNECTION_POOL once, at import.
//
// Scenarios (cap 2 unless stated):
//   P-parallel      4 getConnection calls for distinct sessions in parallel: 2 resolve, 2 reject with
//                   the cap error, 2 entries. Red before #581 (4 entries).
//   P-switch        A switches to a budget on another server; C then D call getConnection in the
//                   window between A's shutdown and A's re-create: C resolves, D gets the cap error,
//                   A's switch resolves on a pool entry for the new budget, 2 entries and no
//                   reservation left. Red before #581, and red when switchBudget takes no slot (A
//                   loses its slot to D and silently falls back to legacy).
//   P-catch         (negative, cap 1) a login that rejects once inside the real getConnection
//                   releases its slot: the next session is admitted, pendingReservations 0. Red
//                   when getConnection's catch release is removed.
//   P-refused       (negative, cap 1) a switch whose session holds no slot at a full cap still
//                   switches (legacy fallback, no throw) and leaves no reservation.
//   P-stdio/skip    (negative) a stdio switch and a skip-init switch leave no reservation.
//   P-idempotent    reserve twice and release twice for one id count once; a held entry
//                   re-reserves at a full cap while a new id is refused; shutdownConnection leaves
//                   a reservation alone; a double release does not touch another id's reservation.
//   P-pool-off      (negative) USE_CONNECTION_POOL=false: actualConnection.reserveSession always
//                   admits and reserves nothing.
//
// Run: node tests/unit/pool_admission_reservation.test.js

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SENTINEL = '__POOL_ADMISSION_581__ ';

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok: ${label}`); passed++; }
  catch (err) { console.error(`  FAIL: ${label} -> ${err.message}`); failed++; }
}

const STUBS = `
const apiMod = await import('@actual-app/api');
const api = apiMod.default || apiMod;
let initDelay = 0;
let initFailures = 0;
// Two servers are configured (BUDGET_1 is on another one), so the login is our own fetch (#574)
// followed by a credential-less api.init. The delay and the failure live in the login.
globalThis.fetch = async () => {
  if (initDelay) await new Promise((res) => setTimeout(res, initDelay));
  if (initFailures > 0) { initFailures--; throw new Error('login refused (stub)'); }
  return new Response(JSON.stringify({ status: 'ok', data: { token: 'tok-581' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
api.init = async () => ({ send: async () => undefined });
api.shutdown = async () => undefined;
api.getServerVersion = async () => ({ version: '26.0.0' });
api.downloadBudget = async () => undefined;
api.loadBudget = async () => undefined;
api.getBudgetMonths = async () => ['2026-10'];
api.sync = async () => undefined;
const { connectionPool } = await import('./dist/src/lib/ActualConnectionPool.js');
const pending = () => connectionPool.getStats().pendingReservations ?? 0;
const results = {};
const settle = (p) => p.then(() => 'ok', (e) => 'err: ' + e.message);
`;
const TAIL = `
process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(results) + '\\n');
process.exit(0);
`;

const CAP2 = `${STUBS}
const adapterMod = await import('./dist/src/lib/actual-adapter.js');
const { requestContext } = await import('./dist/src/lib/requestContext.js');

initDelay = 100;
const par = await Promise.all(['p1', 'p2', 'p3', 'p4'].map((s) => settle(connectionPool.getConnection(s))));
results.parallel = { outcomes: par, entries: connectionPool.connections.size, pending: pending() };
for (const s of ['p1', 'p2', 'p3', 'p4']) await connectionPool.shutdownConnection(s);

initDelay = 0;
await connectionPool.getConnection('A');
// The window is between shutdownConnection deleting A's entry and A's own getConnection
// reserving, a few microtasks long. Two new sessions arrive exactly inside it: the delete is
// hooked so C and D call getConnection synchronously the moment A's entry is gone.
initDelay = 50;
let c, d;
const realDelete = connectionPool.connections.delete.bind(connectionPool.connections);
connectionPool.connections.delete = (id) => {
  const out = realDelete(id);
  if (id === 'A' && !c) { c = settle(connectionPool.getConnection('C')); d = settle(connectionPool.getConnection('D')); }
  return out;
};
const sw = await settle(requestContext.run({ sessionId: 'A', transport: 'http' }, () => adapterMod.switchBudget('Remote')));
connectionPool.connections.delete = realDelete;
results.switch = { c: await c, d: await d, a: sw, aEntry: connectionPool.getConnectionInfo('A')?.syncId ?? null, entries: connectionPool.connections.size, pending: pending() };
for (const s of ['A', 'C', 'D']) await connectionPool.shutdownConnection(s);

initDelay = 0;
results.idem = {};
connectionPool.reserveSession('X');
connectionPool.reserveSession('X');
results.idem.afterTwoReserves = pending();
connectionPool.releaseReservation('X');
connectionPool.releaseReservation('X');
results.idem.afterTwoReleases = pending();
await connectionPool.getConnection('E1');
await connectionPool.getConnection('E2');
results.idem.heldReReserve = connectionPool.reserveSession('E1');
results.idem.newRefused = connectionPool.reserveSession('N');
connectionPool.releaseReservation('E1');
results.idem.entriesAfterHeldRelease = connectionPool.getStats().activeSessions;
await connectionPool.shutdownConnection('E1');
await connectionPool.shutdownConnection('E2');
connectionPool.reserveSession('R');
await connectionPool.shutdownConnection('R');
results.idem.afterShutdown = pending();
connectionPool.releaseReservation('R');
connectionPool.reserveSession('Z');
initFailures = 1;
results.idem.qFailed = await settle(connectionPool.getConnection('Q'));
connectionPool.releaseReservation('Q');
results.idem.zKept = pending();
connectionPool.releaseReservation('Z');
${TAIL}`;

const CAP1 = `${STUBS}
const adapterMod = await import('./dist/src/lib/actual-adapter.js');
const { requestContext } = await import('./dist/src/lib/requestContext.js');

initFailures = 1;
results.catch = { s1: await settle(connectionPool.getConnection('S1')) };
results.catch.s2 = await settle(connectionPool.getConnection('S2'));
results.catch.pending = pending();

results.refused = { a: await settle(requestContext.run({ sessionId: 'A', transport: 'http' }, () => adapterMod.switchBudget('Remote'))) };
results.refused.pending = pending();
results.refused.entries = connectionPool.connections.size;

// Both rows run with the cap-1 slot FREE, so a switch that wrongly reserved would succeed and
// leave pendingReservations at 1. With S2 still holding the slot the reserve would be refused
// and the row could not fail (review round 1).
await connectionPool.shutdownConnection('S2');
results.stdio = { s: await settle(requestContext.run({ sessionId: 'stdio-1', transport: 'stdio' }, () => adapterMod.switchBudget('Remote'))) };
results.stdio.pending = pending();

adapterMod._setSkipApiInitForTests(true);
results.skip = { s: await settle(requestContext.run({ sessionId: 'K', transport: 'http' }, () => adapterMod.switchBudget('Remote'))) };
results.skip.pending = pending();
${TAIL}`;

const NOPOOL = `${STUBS}
const conn = await import('./dist/src/actualConnection.js');
results.nopool = { admitted: ['n1', 'n2', 'n3', 'n4', 'n5'].map((s) => conn.reserveSession(s)), pending: pending() };
${TAIL}`;

function runChild(script, extraEnv) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pool-admission-581-'));
  const env = {
    ...process.env,
    ACTUAL_SERVER_URL: 'http://x:5006',
    ACTUAL_PASSWORD: 'pw-x',
    ACTUAL_BUDGET_SYNC_ID: 'alpha-sync',
    BUDGET_1_NAME: 'Remote',
    BUDGET_1_SYNC_ID: 'remote-sync',
    BUDGET_1_SERVER_URL: 'http://y:5006',
    BUDGET_1_PASSWORD: 'pw-y',
    AUTH_PROVIDER: 'none',
    AUTH_BUDGET_ACL: undefined,
    USE_CONNECTION_POOL: undefined,
    NODE_ENV: 'production',
    MCP_BRIDGE_DATA_DIR: dataDir,
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  rmSync(dataDir, { recursive: true, force: true });
  let r = null;
  check(`child (${JSON.stringify(extraEnv)}) ran to completion`, () => {
    assert.strictEqual(child.signal, null, 'child hung');
    assert.strictEqual(child.status, 0, `child exited ${child.status}\n${(child.stderr || '').slice(-2000)}\n${(child.stdout || '').slice(-2000)}`);
    const lines = (child.stdout || '').split('\n').filter((l) => l.startsWith(SENTINEL));
    assert.strictEqual(lines.length, 1, 'expected one sentinel line');
    r = JSON.parse(lines[0].slice(SENTINEL.length));
  });
  return r;
}

const CAP_ERR = /^err: \[ConnectionPool\] Max concurrent sessions \(2\) reached/;

console.log('\n[#581 pool admission] reservations inside the real getConnection and switchBudget');
const r2 = runChild(CAP2, { MAX_CONCURRENT_SESSIONS: '2' });
if (r2) {
  check('P-parallel 4 parallel getConnection under a cap of 2: 2 resolve, 2 get the cap error, 2 entries', () => {
    assert.strictEqual(r2.parallel.outcomes.filter((o) => o === 'ok').length, 2, JSON.stringify(r2.parallel.outcomes));
    assert.strictEqual(r2.parallel.outcomes.filter((o) => CAP_ERR.test(o)).length, 2, JSON.stringify(r2.parallel.outcomes));
    assert.strictEqual(r2.parallel.entries, 2);
    assert.strictEqual(r2.parallel.pending, 0);
  });
  check('P-switch a parked slow-path switch keeps its slot: C admitted, D refused, A switched, no reservation left', () => {
    assert.strictEqual(r2.switch.c, 'ok');
    assert.match(r2.switch.d, CAP_ERR);
    assert.strictEqual(r2.switch.a, 'ok');
    assert.strictEqual(r2.switch.aEntry, 'remote-sync', 'A lost its slot during the switch and fell back to legacy');
    assert.strictEqual(r2.switch.entries, 2);
    assert.strictEqual(r2.switch.pending, 0);
  });
  check('P-idempotent reserve and release count once per id', () => {
    assert.strictEqual(r2.idem.afterTwoReserves, 1);
    assert.strictEqual(r2.idem.afterTwoReleases, 0);
  });
  check('P-idempotent a held entry re-reserves at a full cap, a new id is refused, the entry survives the release', () => {
    assert.strictEqual(r2.idem.heldReReserve, true);
    assert.strictEqual(r2.idem.newRefused, false);
    assert.strictEqual(r2.idem.entriesAfterHeldRelease, 2);
  });
  check('P-idempotent shutdownConnection leaves a reservation in place', () => {
    assert.strictEqual(r2.idem.afterShutdown, 1);
  });
  check("P-idempotent a caller's double release after a failed getConnection keeps another id's reservation", () => {
    assert.match(r2.idem.qFailed, /login refused|network-failure/);
    assert.strictEqual(r2.idem.zKept, 1);
  });
}

const r1 = runChild(CAP1, { MAX_CONCURRENT_SESSIONS: '1' });
if (r1) {
  check('P-catch (negative) a login failure inside getConnection releases its slot: the next session is admitted', () => {
    assert.match(r1.catch.s1, /login refused|network-failure/);
    assert.strictEqual(r1.catch.s2, 'ok');
    assert.strictEqual(r1.catch.pending, 0);
  });
  check('P-refused (negative) a switch refused a slot at a full cap still switches and leaves no reservation', () => {
    assert.strictEqual(r1.refused.a, 'ok');
    assert.strictEqual(r1.refused.pending, 0);
    assert.strictEqual(r1.refused.entries, 1);
  });
  check('P-stdio (negative) a stdio switch leaves no reservation', () => {
    assert.strictEqual(r1.stdio.s, 'ok');
    assert.strictEqual(r1.stdio.pending, 0);
  });
  check('P-skip (negative) a skip-init switch leaves no reservation', () => {
    assert.strictEqual(r1.skip.s, 'ok');
    assert.strictEqual(r1.skip.pending, 0);
  });
}

const r0 = runChild(NOPOOL, { MAX_CONCURRENT_SESSIONS: '2', USE_CONNECTION_POOL: 'false' });
if (r0) {
  check('P-pool-off (negative) with pooling off reserveSession always admits and reserves nothing', () => {
    assert.deepStrictEqual(r0.nopool.admitted, [true, true, true, true, true]);
    assert.strictEqual(r0.nopool.pending, 0);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// tests/unit/pool_orphan_sweep.test.js
//
// #530: a session whose pool entry was recycled WITHOUT eviction (an infra-error
// drop, switchBudget's slow path) kept its transport, owner record and init promise
// forever if the client never came back, because nothing timed an entry-less
// session. httpServer now registers every session with the pool, `touch` stamps the
// registration, and the idle sweep reaps a registered id that has no entry and was
// not served for one idle window (listener reason `orphaned`).
//
// Pool half: in-process against the real sweep with a stepped clock (P1 to P11; P9 to P11
// cover the in-flight count from review round 1: a request still running past the idle
// window must not get its session reaped).
// Server half: a child process running the real server in OIDC mode, modeled on
// session_ownership_express.test.js (the only stub is connectionPool.getConnection),
// plus source guards on httpServer (S cases).
//
// Run: node tests/unit/pool_orphan_sweep.test.js
// Linked issue: https://github.com/agigante80/actual-mcp-server/issues/530

process.env.ACTUAL_SERVER_URL = process.env.ACTUAL_SERVER_URL || 'http://test-server';
process.env.ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD || 'sentinel-pwd-DO-NOT-LEAK';
process.env.ACTUAL_BUDGET_SYNC_ID = process.env.ACTUAL_BUDGET_SYNC_ID || 'unit-test-sync-id';
process.env.SESSION_IDLE_TIMEOUT_MINUTES = '1'; // one window = 60 s, stepped below

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0;
let failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok: ${label}`); passed++; }
  catch (err) { console.error(`  FAIL: ${label} -> ${err.message}`); failed++; }
}

// Stepped clock: the pool reads Date.now() at every decision.
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const step = (ms) => { offset += ms; };

const { connectionPool } = await import('../../dist/src/lib/ActualConnectionPool.js');
await connectionPool.waitForInitialization();
connectionPool.connections.clear();
const IDLE = connectionPool.getIdleTimeoutMinutes() * 60 * 1000;
assert.strictEqual(IDLE, 60_000, 'SESSION_IDLE_TIMEOUT_MINUTES=1 must be in force before import');

const fired = [];
connectionPool.onSessionEvicted((sid, reason) => { fired.push({ sid, reason }); });
const firedFor = (sid) => fired.filter((f) => f.sid === sid);
const seed = (sid, lastActivity) => connectionPool.connections.set(sid, {
  sessionId: sid, initialized: true, lastActivity,
  dataDir: '/tmp/test', serverUrl: 'http://test-server', password: 'x', syncId: 'unit-test-sync-id',
});

console.log('\n[pool-orphan-sweep] pool half');

await check('P1 a registered session with no entry is reaped after one idle window, exactly once', async () => {
  connectionPool.registerSession('o1');
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('o1'), [], 'nothing inside the window');
  step(IDLE + 1000);
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('o1'), [{ sid: 'o1', reason: 'orphaned' }]);
  assert.strictEqual(connectionPool.registered.has('o1'), false, 'registration dropped');
  await connectionPool.cleanupIdleConnections();
  assert.strictEqual(firedFor('o1').length, 1, 'a second sweep fires nothing');
});

await check('P2 touch stamps the registration, so a served entry-less session stays alive', async () => {
  connectionPool.registerSession('o2');
  step(IDLE - 1000);
  connectionPool.touch('o2');
  step(2000); // 61 s since registration, 2 s since the touch
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('o2'), [], 'kept alive by the touch');
  step(IDLE + 1000);
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('o2'), [{ sid: 'o2', reason: 'orphaned' }]);
});

await check('P3 an entry expires on the later of its lastActivity and the registration; eviction drops the registration', async () => {
  seed('e3', Date.now() - IDLE - 1000);
  connectionPool.registerSession('e3');
  await connectionPool.cleanupIdleConnections();
  assert.strictEqual(connectionPool.hasConnection('e3'), true, 'a fresh registration keeps a stale entry');
  assert.deepStrictEqual(firedFor('e3'), []);
  step(IDLE + 1000);
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('e3'), [{ sid: 'e3', reason: 'evicted' }], 'the #167 path, with its reason');
  assert.strictEqual(connectionPool.hasConnection('e3'), false);
  assert.strictEqual(connectionPool.registered.has('e3'), false, 'eviction dropped the registration');
  await connectionPool.cleanupIdleConnections();
  assert.strictEqual(firedFor('e3').length, 1, 'never reaped a second time as an orphan');
});

await check('P4 forgetSession is idempotent and ends the timing', async () => {
  connectionPool.registerSession('o4');
  connectionPool.forgetSession('o4');
  connectionPool.forgetSession('o4');
  step(IDLE + 1000);
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('o4'), []);
});

await check('P5 an explicit close with evict:true fires evicted once and no orphaned later', async () => {
  seed('e5', Date.now());
  connectionPool.registerSession('e5');
  await connectionPool.shutdownConnection('e5', { evict: true });
  assert.deepStrictEqual(firedFor('e5'), [{ sid: 'e5', reason: 'evicted' }]);
  assert.strictEqual(connectionPool.registered.has('e5'), false);
  step(IDLE + 1000);
  await connectionPool.cleanupIdleConnections();
  assert.strictEqual(firedFor('e5').length, 1);
});

await check('P6 touch never registers an unknown id', async () => {
  connectionPool.touch('never-registered');
  assert.strictEqual(connectionPool.registered.has('never-registered'), false);
  step(IDLE + 1000);
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('never-registered'), []);
});

await check('P8 a stale registration with a fresh entry is not reaped (the entry proves the session is alive)', async () => {
  seed('e8', Date.now());
  connectionPool.registered.set('e8', Date.now() - IDLE - 1000);
  await connectionPool.cleanupIdleConnections();
  assert.strictEqual(connectionPool.hasConnection('e8'), true);
  assert.deepStrictEqual(firedFor('e8'), []);
  connectionPool.connections.delete('e8');
  connectionPool.forgetSession('e8');
});

await check('P9 a session with a request in flight is not reaped however long it runs; the window restarts when it ends', async () => {
  connectionPool.registerSession('o9');
  connectionPool.beginRequest('o9');
  step(IDLE * 3);
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('o9'), [], 'in flight: never an orphan');
  connectionPool.endRequest('o9');
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('o9'), [], 'endRequest touched: a fresh window starts at the end of the request');
  step(IDLE + 1000);
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('o9'), [{ sid: 'o9', reason: 'orphaned' }]);
});

await check('P10 overlapping requests are counted: the session is reapable only after the LAST one ends', async () => {
  connectionPool.registerSession('o10');
  connectionPool.beginRequest('o10');
  connectionPool.beginRequest('o10');
  connectionPool.endRequest('o10');
  step(IDLE + 1000);
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('o10'), [], 'one request still in flight');
  connectionPool.endRequest('o10');
  connectionPool.endRequest('o10'); // a stray extra end is harmless
  step(IDLE + 1000);
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('o10'), [{ sid: 'o10', reason: 'orphaned' }]);
  assert.strictEqual(connectionPool.inFlight.has('o10'), false);
});

await check('P11 an eviction clears the in-flight count, and a late endRequest neither throws nor revives the session', async () => {
  seed('e11', Date.now());
  connectionPool.registerSession('e11');
  connectionPool.beginRequest('e11');
  await connectionPool.shutdownConnection('e11', { evict: true });
  assert.deepStrictEqual(firedFor('e11'), [{ sid: 'e11', reason: 'evicted' }]);
  assert.strictEqual(connectionPool.inFlight.has('e11'), false, 'count cleared by the eviction');
  connectionPool.endRequest('e11');
  assert.strictEqual(connectionPool.inFlight.has('e11'), false, 'a late end does not count anything');
});

await check('P7 shutdownAll clears every registration and in-flight count', async () => {
  connectionPool.registerSession('o7');
  connectionPool.beginRequest('o7');
  await connectionPool.shutdownAll();
  assert.strictEqual(connectionPool.registered.size, 0);
  assert.strictEqual(connectionPool.inFlight.size, 0);
  step(IDLE + 1000);
  await connectionPool.cleanupIdleConnections();
  assert.deepStrictEqual(firedFor('o7'), []);
});

// ---------------------------------------------------------------------------
console.log('\n[pool-orphan-sweep] server half (child process, OIDC, two principals)');

const ISSUER = 'https://idp.test';
const RESOURCE = 'https://actual-mcp.example.com/http';
const SENTINEL = '__ORPHAN_RESULT__ ';
const SUB_A = 'sub-owner-a-7c1e';
const SUB_B = 'sub-other-b-9d2f';

const CHILD = `
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
const ISSUER = ${JSON.stringify(ISSUER)};
const RESOURCE = ${JSON.stringify(RESOURCE)};
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset; // jose validates exp with new Date(), unaffected
const step = (ms) => { offset += ms; };
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey); jwk.alg = 'RS256'; jwk.kid = 'k1';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (u.startsWith(ISSUER + '/')) {
    if (u.endsWith('/.well-known/openid-configuration')) {
      return Response.json({ issuer: ISSUER, jwks_uri: ISSUER + '/jwks', userinfo_endpoint: ISSUER + '/userinfo',
        authorization_endpoint: ISSUER + '/authorize', token_endpoint: ISSUER + '/token', response_types_supported: ['code'] });
    }
    if (u.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    return new Response('not stubbed: ' + u, { status: 404 });
  }
  throw new Error('fetch stub: refused ' + u);
};

const { connectionPool } = await import('./dist/src/lib/ActualConnectionPool.js');
const IDLE = connectionPool.getIdleTimeoutMinutes() * 60 * 1000;
connectionPool.getConnection = async (sid) => {
  connectionPool.connections.set(sid, {
    sessionId: sid, initialized: true, lastActivity: Date.now(),
    dataDir: '/nonexistent', serverUrl: 'http://localhost:5006', password: 'x', syncId: 's',
  });
  return connectionPool.connections.get(sid);
};
const mcp = { executeTool: async () => ({ ok: true }) };
const { startHttpServer } = await import('./dist/src/server/httpServer.js');
const { listener, cleanup } = await startHttpServer(mcp, 0, '/http', {}, ['actual_accounts_list'], 'desc', 'instr', {}, 'test', '127.0.0.1', undefined);
if (!listener.listening) await new Promise((res, rej) => { listener.once('listening', res); listener.once('error', rej); });
const base = 'http://127.0.0.1:' + listener.address().port + '/http';

const tokenFor = (sub) => new SignJWT({ scope: 'openid' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
  .setIssuer(ISSUER).setAudience(RESOURCE).setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);
const tokenA = await tokenFor(${JSON.stringify(SUB_A)});
const tokenB = await tokenFor(${JSON.stringify(SUB_B)});

const post = async (token, sid, body) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token };
  if (sid) headers['mcp-session-id'] = sid;
  const r = await realFetch(base, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, sessionId: r.headers.get('mcp-session-id'), body: await r.text() };
};
const get = async (token, sid) => {
  const ac = new AbortController();
  const headers = { Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token, 'mcp-session-id': sid };
  const r = await realFetch(base, { method: 'GET', headers, signal: ac.signal });
  const type = r.headers.get('content-type') || '';
  let body = null;
  if (!type.includes('text/event-stream')) body = await r.text();
  ac.abort();
  return { status: r.status, contentType: type, body };
};
const initBody = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'orphan-test', version: '0' } } };
const call = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'actual_accounts_list', arguments: {} } };
const list = { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} };
const sweep = () => connectionPool.cleanupIdleConnections();
const dropEntry = (sid) => connectionPool.connections.delete(sid); // the infra-error recycle, without eviction
const results = {};

// S-pos: a session is registered when its transport is.
const initA = await post(tokenA, undefined, initBody);
const sidA = initA.sessionId;
results.sidA = sidA;
results.registeredA = connectionPool.registered.has(sidA);
results.entryA = connectionPool.hasConnection(sidA);

// S-a: entry dropped, no request for one window: reaped; A's next call gets the unknown-id reply.
dropEntry(sidA);
step(IDLE + 1000);
await sweep();
results.registeredAfterReap = connectionPool.registered.has(sidA);
results.callAfterReap = await post(tokenA, sidA, call);

// S-b: entry dropped, A keeps using the session: alive across the window; silence then reaps it.
const sidB = (await post(tokenA, undefined, initBody)).sessionId;
dropEntry(sidB);
step(IDLE / 2);
results.servedB = await post(tokenA, sidB, call); // a tools/call: tools/list is answered for a torn-down id too
step(IDLE / 2 + 1000); // 61 s since registration, 31 s since the request
await sweep();
results.registeredBAfterUse = connectionPool.registered.has(sidB);
step(IDLE + 1000);
await sweep();
results.registeredBAfterSilence = connectionPool.registered.has(sidB);
results.callBAfterSilence = await post(tokenA, sidB, call);

// S-b-GET: a GET on the event stream keeps an entry-less session alive too.
const sidC = (await post(tokenA, undefined, initBody)).sessionId;
dropEntry(sidC);
step(IDLE / 2);
results.getC = await get(tokenA, sidC);
step(IDLE / 2 + 1000);
await sweep();
results.registeredCAfterGet = connectionPool.registered.has(sidC);
step(IDLE + 1000);
await sweep();
results.registeredCAfterSilence = connectionPool.registered.has(sidC);

// S-c: another principal's requests with the id do not keep the orphan alive.
const sidD = (await post(tokenA, undefined, initBody)).sessionId;
dropEntry(sidD);
step(IDLE / 2);
results.byBOnD = await post(tokenB, sidD, call);
step(IDLE / 2 + 1000);
await sweep();
results.registeredDAfterB = connectionPool.registered.has(sidD);
results.callDByA = await post(tokenA, sidD, call);

await new Promise((res) => listener.close(res));
process.removeListener('SIGTERM', cleanup); process.removeListener('SIGINT', cleanup);
process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(results) + '\\n');
process.exit(0);
`;

const env = {
  ...process.env,
  ACTUAL_SERVER_URL: 'http://localhost:5006',
  ACTUAL_PASSWORD: 'stub-password-for-unit-test',
  ACTUAL_BUDGET_SYNC_ID: '00000000-0000-0000-0000-000000000000',
  AUTH_PROVIDER: 'oidc',
  OIDC_ISSUER: ISSUER,
  OIDC_RESOURCE: RESOURCE,
  OIDC_ACCEPTED_AUDIENCES: undefined,
  AUTH_BUDGET_ACL: undefined,
  USE_CONNECTION_POOL: undefined,
  SESSION_IDLE_TIMEOUT_MINUTES: '1',
  NODE_ENV: 'production',
};
const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
const resultLines = (child.stdout || '').split('\n').filter((l) => l.startsWith(SENTINEL));
assert.strictEqual(child.signal, null, 'child hung');
assert.strictEqual(child.status, 0, `child exited ${child.status}\n${(child.stderr || '').slice(-2000)}\n${(child.stdout || '').slice(-2000)}`);
assert.strictEqual(resultLines.length, 1, 'expected one sentinel line');
const r = JSON.parse(resultLines[0].slice(SENTINEL.length));
const output = (child.stdout || '') + (child.stderr || '');
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
const isUnknownId = (reply) => reply.status === 404 && json(reply.body)?.error?.code === -32001;

await check('S-pos initialize registers the session with the pool beside its entry', () => {
  assert.strictEqual(r.registeredA, true);
  assert.strictEqual(r.entryA, true);
});
await check('S-a an entry-less session with no request for one window is torn down: unknown-id reply, registration gone', () => {
  assert.strictEqual(r.registeredAfterReap, false);
  assert.ok(isUnknownId(r.callAfterReap), `got ${r.callAfterReap.status} ${r.callAfterReap.body}`);
});
await check('S-a the orphan teardown is logged exactly once for the session', () => {
  const line = `Transport torn down for orphaned session: ${r.sidA}`;
  assert.strictEqual(output.split(line).length - 1, 1, 'one log line');
});
await check('S-b the owner\'s POST keeps an entry-less session alive across the window', () => {
  assert.strictEqual(r.servedB.status, 200, `served: ${r.servedB.body}`);
  assert.strictEqual(r.registeredBAfterUse, true);
});
await check('S-b one silent window after the last request reaps it', () => {
  assert.strictEqual(r.registeredBAfterSilence, false);
  assert.ok(isUnknownId(r.callBAfterSilence));
});
await check('S-b-GET the owner\'s GET keeps an entry-less session alive; silence then reaps it', () => {
  assert.strictEqual(r.getC.status, 200);
  assert.ok(r.getC.contentType.includes('text/event-stream'));
  assert.strictEqual(r.registeredCAfterGet, true);
  assert.strictEqual(r.registeredCAfterSilence, false);
});
await check('S-c another principal\'s requests do not keep the orphan alive', () => {
  assert.ok(isUnknownId(r.byBOnD), 'B is refused with the unknown-id reply');
  assert.strictEqual(r.registeredDAfterB, false, 'reaped after one window despite B\'s request');
  assert.ok(isUnknownId(r.callDByA));
});

const src = readFileSync(join(ROOT, 'src', 'server', 'httpServer.ts'), 'utf8');
await check('S-pool-off registerSession runs only under isConnectionPoolEnabled(), after transports.set', () => {
  const line = src.split('\n').find((l) => l.includes('connectionPool.registerSession(sid)'));
  assert.ok(line, 'registerSession call present');
  assert.match(line, /if \(isConnectionPoolEnabled\(\)\) connectionPool\.registerSession\(sid\);/);
  assert.ok(src.indexOf('transports.set(sid, transport);') < src.indexOf('connectionPool.registerSession(sid)'));
  const conn = readFileSync(join(ROOT, 'src', 'actualConnection.ts'), 'utf8');
  assert.match(conn, /export function isConnectionPoolEnabled\(\): boolean \{\s*return useConnectionPool;/);
});
await check('S-sync the teardown body is synchronous, clears both tables, the owner and the registration, and is the eviction listener', () => {
  const start = src.indexOf('function teardownSession(');
  assert.ok(start > 0, 'teardownSession present');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.ok(!/\bawait\b/.test(body), 'no await');
  for (const needle of ['transports.delete(sessionId);', 'sessionInitPromises.delete(sessionId);', 'forgetSessionOwner(sessionId);', 'connectionPool.forgetSession(sessionId);']) {
    assert.ok(body.includes(needle), needle);
  }
  assert.ok(src.includes('connectionPool.onSessionEvicted(teardownSession);'));
});
await check('S-unknown both routes check ownership before touching the session', () => {
  const post = src.slice(src.indexOf('app.post(httpPath'), src.indexOf('app.get(httpPath'));
  const get = src.slice(src.indexOf('app.get(httpPath'), src.indexOf("app.get('/mcp-info'"));
  for (const [name, route, needle] of [['POST', post, 'connectionPool.beginRequest(sessionId);'], ['GET', get, 'connectionPool.touch(sessionId);']]) {
    const guard = route.indexOf('sessionOwnerMatches(sessionId, resolvePrincipal(req))');
    const touch = route.indexOf(needle);
    assert.ok(guard > 0 && touch > guard, `${name}: guard before touch`);
  }
});

await check('S-inflight POST marks the request in flight and ends it through stream.finished (fires for an already-closed response); GET only touches', () => {
  const post = src.slice(src.indexOf('app.post(httpPath'), src.indexOf('app.get(httpPath'));
  const get = src.slice(src.indexOf('app.get(httpPath'), src.indexOf("app.get('/mcp-info'"));
  const begin = post.indexOf('connectionPool.beginRequest(sessionId);');
  // Not res.once('close'): a client that aborted during the init wait closed the response
  // before the listener existed, and the count would never come back down (review round 2).
  const end = post.indexOf('finished(res, () => connectionPool.endRequest(sessionId));');
  const handle = post.lastIndexOf('transport.handleRequest(req, res, req.body)');
  assert.ok(begin > 0 && end > begin && handle > end, 'begin, then the finished hook, then the handler');
  assert.ok(src.includes("import { finished } from 'node:stream';"), 'finished comes from node:stream');
  assert.ok(!post.includes("res.once('close', () => connectionPool.endRequest"), 'no close listener for the in-flight count (the comment may name it)');
  assert.ok(!post.includes('connectionPool.touch(sessionId);'), 'POST touches through beginRequest only');
  assert.ok(!get.includes('beginRequest'), 'an idle GET stream must not pin an orphan');
});

await check('N-finished (Node witness) stream.finished calls back for a response the client already closed; a late close listener never does', async () => {
  const { createServer, request } = await import('node:http');
  const { finished } = await import('node:stream');
  let resolveHandler;
  const handlerDone = new Promise((r) => { resolveHandler = r; });
  const server = createServer(async (_req, res) => {
    await new Promise((r) => res.once('close', r)); // the "init wait": the client aborts during it
    const lateClose = new Promise((r) => { res.once('close', () => r('close')); setTimeout(() => r('timeout'), 200); });
    const fin = new Promise((r) => { finished(res, () => r('finished')); setTimeout(() => r('timeout'), 200); });
    resolveHandler({ closed: res.closed, lateClose: await lateClose, fin: await fin });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const req = request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/' });
  req.on('error', () => {});
  req.write('{'); // headers out, body never completed
  setTimeout(() => req.destroy(), 50);
  const r = await handlerDone;
  server.close();
  assert.strictEqual(r.closed, true, 'the response was closed by the abort');
  assert.strictEqual(r.lateClose, 'timeout', 'a close listener attached after the abort never fires');
  assert.strictEqual(r.fin, 'finished', 'finished still calls back');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

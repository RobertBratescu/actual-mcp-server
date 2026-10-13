// tests/unit/session_ownership_express.test.js
//
// #529: the POST and GET ownership checks in src/server/httpServer.ts, exercised
// over Express with TWO OIDC principals. tests/unit/session_ownership.test.js
// covers the predicate and the session tools; the transport-visible replies were
// pinned only by source-text guards, which prove the check runs but not what the
// client sees. The v0.22.18 review found exactly such a divergence (tools/list)
// before release, so the replies are compared byte for byte here.
//
// The real server runs in a CHILD process in OIDC mode (config.ts parses env
// once, like the #461 and #463 harnesses). Discovery and the JWKS are served by a
// fetch stub, the tokens are real RS256 JWTs for two subjects, and jose verifies
// them through the server's own customJwtVerify: nothing on the auth path is
// replaced. The only stub is connectionPool.getConnection, which would need a
// live Actual server; it seeds a pool entry so session init succeeds and the
// transport is registered for principal A.
//
// Scenarios (GWT in the ticket):
//   1. B POSTs tools/call with A's id: 404, -32001, the unknown-id body, no touch.
//   2. B POSTs tools/list with A's id: byte-identical to the unknown-id reply.
//   3. B GETs with A's id: 400, -32000, "Transport not ready", the unknown-id body,
//      no touch; and a pool entry with no transport is not touched either (the
//      GET route now touches only a session it will serve, like POST).
//   4. A, with A's own id, is served (tools/list 200 with the list, tools/call
//      reaches the executor, GET reaches the transport) and A's clock is touched.
//   5. A session still initializing (the getConnection stub holds a deferred, so
//      transports.set has not run): B's GET gets the unknown-id reply and the
//      entry's clock is not touched. This is the case the touch move exists for.
//   6. (#550) A session whose init FAILED: the stub rejects once with ECONNREFUSED
//      before seeding any entry, so the #438 record is the only trace of the id.
//      B's tools/call, tools/list and GET with that id are byte-identical to the
//      unknown-id replies (no cause, no 404 for tools/list); A's tools/call and
//      GET still get the cause reply (404 -32001 and 400 -32000, both with
//      data.cause 'network_unreachable' and sessionInitFailed true), and they get
//      it AFTER B's requests, which proves B's lookups neither consumed nor
//      extended the record.
//
// The child is run three times: in OIDC mode (scenarios 1 to 6), with a static
// bearer and no OIDC (scenario 6 only), where every caller is the same principal
// 'static-bearer', and with authentication disabled (scenario 6 only), where every
// caller's principal is undefined. In both one-principal runs the cause reply must
// still be served to anyone presenting the id, as before #550. The bearer run is
// what keeps the comparison on the failure record's own owner field
// (sessionOwnerMatches would refuse it, because a failed init never records an
// owner in session-owners.ts); the auth-disabled run is what keeps it a plain
// strict equality (an added `!principal` guard would drop the cause reply there).
//
// Mutation check (manual, recorded in the #529 and #550 commits): removing either
// ownership branch or changing its reply turns scenario 1, 2 or 3 red; moving the
// GET touch back ahead of the transport lookup turns scenario 5 red; removing the
// owner comparison from peekInitFailure turns the B cases of scenario 6 red;
// dropping the owner from rememberInitFailure turns A's cases of scenario 6 red;
// comparing through sessionOwnerMatches turns the bearer run red.
//
// Run: node tests/unit/session_ownership_express.test.js

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ISSUER = 'https://idp.test';
const RESOURCE = 'https://actual-mcp.example.com/http';
const SENTINEL = '__OWNERSHIP_RESULT__ ';
const SUB_A = 'sub-owner-a-7c1e';
const SUB_B = 'sub-other-b-9d2f';
const BEARER = 'static-bearer-token-for-unit-test-550';
const STALE = 1_700_000_000_000; // a fixed lastActivity, so a touch is visible as any later value

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok: ${label}`); passed++; }
  catch (err) { console.error(`  FAIL: ${label} -> ${err.message}`); failed++; }
}

// mode: 'oidc' runs every scenario with two RS256 subjects; 'bearer' and 'noauth'
// run only the failed-init scenario with their one principal. The harness is
// otherwise identical, so those runs prove the cause reply survives #550 on the
// SAME code path the OIDC run exercises. In 'noauth' the Authorization header the
// helpers send is simply ignored by the server.
const childFor = (mode) => `
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { randomUUID } from 'node:crypto';
const MODE = ${JSON.stringify(mode)};
const ISSUER = ${JSON.stringify(ISSUER)};
const RESOURCE = ${JSON.stringify(RESOURCE)};
const STALE = ${STALE};
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
  // Nothing on the auth path may leave the process: any other host is a test bug.
  throw new Error('fetch stub: refused ' + u);
};

// The one stub: a pool entry per initialized session, no Actual server behind it.
// waitForInitialization is the real one (the pool's boot clears the map, so seeding
// only ever happens inside a request, after boot has settled). When hold is set the
// stub seeds the entry and parks on a deferred, which freezes the session between the
// pool entry existing and transports.set running: the "still initializing" state.
const { connectionPool } = await import('./dist/src/lib/ActualConnectionPool.js');
const seedEntry = (sid) => connectionPool.connections.set(sid, {
  sessionId: sid, initialized: true, lastActivity: Date.now(),
  dataDir: '/nonexistent', serverUrl: 'http://localhost:5006', password: 'x', syncId: 's',
});
let hold = null; // { sid, release } while an initialize is parked
// #550: when set, the next getConnection rejects BEFORE seeding, the way a real
// refused connection leaves nothing behind. ECONNREFUSED is in the classifier's
// system-code table (src/lib/init-failure.ts), so the recorded cause is exact.
let failNext = null; // { sid } while a rejecting initialize is expected
connectionPool.getConnection = async (sid) => {
  if (failNext) {
    failNext.sid = sid;
    failNext = null;
    throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
  }
  seedEntry(sid);
  if (hold) {
    hold.sid = sid;
    connectionPool.connections.get(sid).lastActivity = STALE;
    await new Promise((resolve) => { hold.release = resolve; });
  }
  return connectionPool.connections.get(sid);
};

const executed = [];
const mcp = { executeTool: async (name, args) => { executed.push({ name, args }); return { ok: true }; } };
const { startHttpServer } = await import('./dist/src/server/httpServer.js');
const { listener, cleanup } = await startHttpServer(mcp, 0, '/http', {}, ['actual_accounts_list'], 'desc', 'instr', {}, 'test', '127.0.0.1', undefined);
if (!listener.listening) await new Promise((res, rej) => { listener.once('listening', res); listener.once('error', rej); });
const base = 'http://127.0.0.1:' + listener.address().port + '/http';

const tokenFor = (sub) => new SignJWT({ scope: 'openid' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
  .setIssuer(ISSUER).setAudience(RESOURCE).setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);
// In bearer mode A and B are the same principal by construction: one token, one identity.
const tokenA = MODE === 'oidc' ? await tokenFor(${JSON.stringify(SUB_A)}) : ${JSON.stringify(BEARER)};
const tokenB = MODE === 'oidc' ? await tokenFor(${JSON.stringify(SUB_B)}) : ${JSON.stringify(BEARER)};

const post = async (token, sid, body) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token };
  if (sid) headers['mcp-session-id'] = sid;
  const r = await realFetch(base, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, contentType: r.headers.get('content-type') || '', sessionId: r.headers.get('mcp-session-id'), body: await r.text() };
};
// GET: an SSE stream stays open on success, so read only the status and headers.
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

const results = { mode: MODE };
const initParams = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ownership-test', version: '0' } };
const call = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'actual_accounts_list', arguments: {} } };
const list = { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} };

if (MODE === 'oidc') {
// A initializes a session (the owner is resolved from THIS request).
const init = await post(tokenA, undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: initParams });
results.init = { status: init.status, hasSession: Boolean(init.sessionId) };
const sidA = init.sessionId;
// Let onsessioninitialized settle (it awaits the stubbed getConnection) before freezing the clock.
await new Promise((r) => setTimeout(r, 50));
const entryA = connectionPool.connections.get(sidA);
results.poolHasA = Boolean(entryA);
const freeze = () => { entryA.lastActivity = STALE; };
const clockA = () => entryA.lastActivity;
const unknown = randomUUID();

// 1. B POSTs tools/call with A's id.
freeze();
results.callByB = await post(tokenB, sidA, call);
results.callByB.clockAfter = clockA();
results.callUnknown = await post(tokenB, unknown, call);
results.executedAfterB = executed.length;

// 2. B POSTs tools/list with A's id.
freeze();
results.listByB = await post(tokenB, sidA, list);
results.listByB.clockAfter = clockA();
results.listUnknown = await post(tokenB, unknown, list);

// 3. B GETs with A's id; and a GET on a pool entry that has no transport.
freeze();
results.getByB = await get(tokenB, sidA);
results.getByB.clockAfter = clockA();
results.getUnknown = await get(tokenB, unknown);
const orphan = randomUUID();
seedEntry(orphan);
connectionPool.connections.get(orphan).lastActivity = STALE;
results.getOrphan = await get(tokenB, orphan);
results.getOrphan.clockAfter = connectionPool.connections.get(orphan).lastActivity;

// 4. A is served with A's own id.
freeze();
results.listByA = await post(tokenA, sidA, list);
results.listByA.clockAfter = clockA();
freeze();
results.callByA = await post(tokenA, sidA, call);
results.callByA.clockAfter = clockA();
results.executedAfterA = executed.length;
freeze();
results.getByA = await get(tokenA, sidA);
results.getByA.clockAfter = clockA();

// 5. A session still initializing: the SDK answers initialize only after the
// onsessioninitialized hook returns, so the id comes from the stub, not the reply.
hold = { sid: null, release: null };
const initPending = post(tokenA, undefined, { jsonrpc: '2.0', id: 2, method: 'initialize', params: initParams });
for (let i = 0; i < 200 && !hold.release; i++) await new Promise((r) => setTimeout(r, 10));
results.heldCaptured = Boolean(hold.sid && hold.release);
results.getHeld = await get(tokenB, hold.sid);
results.getHeld.clockAfter = connectionPool.connections.get(hold.sid)?.lastActivity;
const release = hold.release; hold = null; release();
results.heldInit = { status: (await initPending).status };
} // MODE === 'oidc'

// 6. (#550) A session whose init FAILED. The SDK still answers initialize (the
// hook's catch records the cause and does not rethrow), so the id is on the reply;
// the stub captures it too, and both must agree.
const failCapture = { sid: null }; // the stub clears failNext, so keep our own reference
failNext = failCapture;
const failInit = await post(tokenA, undefined, { jsonrpc: '2.0', id: 3, method: 'initialize', params: initParams });
const sidF = failInit.sessionId;
results.failInit = { status: failInit.status, sidOnReply: sidF, sidInStub: failCapture.sid };
// Let the hook's catch run (rememberInitFailure) before anyone asks about the id.
await new Promise((r) => setTimeout(r, 50));
results.failPoolHasEntry = connectionPool.connections.has(sidF);
const unknownF = randomUUID();
results.failUnknown = { call: await post(tokenB, unknownF, call), list: await post(tokenB, unknownF, list), get: await get(tokenB, unknownF) };
// B first, then A: A's cause reply afterwards proves B's lookups did not consume the record.
results.failCallByB = await post(tokenB, sidF, call);
results.failListByB = await post(tokenB, sidF, list);
results.failGetByB = await get(tokenB, sidF);
results.failCallByA = await post(tokenA, sidF, call);
results.failListByA = await post(tokenA, sidF, list);
results.failGetByA = await get(tokenA, sidF);

await new Promise((res) => listener.close(res));
process.removeListener('SIGTERM', cleanup); process.removeListener('SIGINT', cleanup);
process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(results) + '\\n');
process.exit(0);
`;

const baseEnv = {
  ...process.env,
  ACTUAL_SERVER_URL: 'http://localhost:5006',
  ACTUAL_PASSWORD: 'stub-password-for-unit-test',
  ACTUAL_BUDGET_SYNC_ID: '00000000-0000-0000-0000-000000000000',
  AUTH_BUDGET_ACL: undefined,
  USE_CONNECTION_POOL: undefined,
  NODE_ENV: 'production', // showErrorDetails off, as in a deployment
};
const ENV = {
  oidc: { ...baseEnv, AUTH_PROVIDER: 'oidc', OIDC_ISSUER: ISSUER, OIDC_RESOURCE: RESOURCE, OIDC_ACCEPTED_AUDIENCES: undefined, MCP_SSE_AUTHORIZATION: undefined },
  bearer: { ...baseEnv, AUTH_PROVIDER: undefined, OIDC_ISSUER: undefined, OIDC_RESOURCE: undefined, OIDC_ACCEPTED_AUDIENCES: undefined, MCP_SSE_AUTHORIZATION: BEARER },
  // The #242 fail-closed check lives in index.ts, not in startHttpServer, and the
  // child binds loopback anyway, so this is the "authentication disabled" posture.
  noauth: { ...baseEnv, AUTH_PROVIDER: undefined, OIDC_ISSUER: undefined, OIDC_RESOURCE: undefined, OIDC_ACCEPTED_AUDIENCES: undefined, MCP_SSE_AUTHORIZATION: undefined, MCP_ALLOW_UNAUTHENTICATED: 'true' },
};
function run(mode) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childFor(mode)], { cwd: ROOT, env: ENV[mode], encoding: 'utf8', timeout: 60000 });
  const resultLines = (child.stdout || '').split('\n').filter((l) => l.startsWith(SENTINEL));
  assert.strictEqual(child.signal, null, `${mode} child hung`);
  assert.strictEqual(child.status, 0, `${mode} child exited ${child.status}\n${(child.stderr || '').slice(-2000)}\n${(child.stdout || '').slice(-2000)}`);
  assert.strictEqual(resultLines.length, 1, `${mode}: expected one sentinel line`);
  return JSON.parse(resultLines[0].slice(SENTINEL.length));
}
const r = run('oidc');
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
const NOT_FOUND = 'Session not found. Please re-initialize by calling initialize without mcp-session-id header.';
const CAUSE = 'network_unreachable';
// The cause reply, as the owner sees it on each route. Shape pinned by
// httpServer_init_failure_report.test.js; here only the fields that decide #550.
function assertCauseReplyPost(reply, id) {
  assert.strictEqual(reply.status, 404, reply.body);
  const j = json(reply.body);
  assert.ok(j, `not JSON: ${reply.body}`);
  assert.strictEqual(j.error?.code, -32001, reply.body);
  assert.strictEqual(j.id, id);
  assert.deepStrictEqual(j.error?.data, { cause: CAUSE, sessionInitFailed: true }, reply.body);
  assert.ok(String(j.error?.message).includes('re-initialize'), reply.body);
}
function assertCauseReplyGet(reply) {
  assert.strictEqual(reply.status, 400, String(reply.body));
  const j = json(reply.body);
  assert.ok(j, `not JSON: ${reply.body}`);
  assert.strictEqual(j.error?.code, -32000, reply.body);
  assert.strictEqual(j.id, null);
  assert.deepStrictEqual(j.error?.data, { cause: CAUSE, sessionInitFailed: true }, reply.body);
}

console.log('\n[session-ownership-express] setup');
check('A initialized a session and the pool holds its entry', () => {
  assert.strictEqual(r.init.status, 200, JSON.stringify(r.init));
  assert.ok(r.init.hasSession, 'no mcp-session-id on the initialize reply');
  assert.ok(r.poolHasA, 'pool entry missing after init');
});

console.log('\n[session-ownership-express] 1. POST tools/call by a non-owner');
check('reply is HTTP 404 with JSON-RPC -32001 and the unknown-session message', () => {
  assert.strictEqual(r.callByB.status, 404, r.callByB.body);
  const j = json(r.callByB.body);
  assert.ok(j, `not JSON: ${r.callByB.body}`);
  assert.strictEqual(j.error?.code, -32001, r.callByB.body);
  assert.strictEqual(j.error?.message, NOT_FOUND);
  assert.strictEqual(j.id, 7);
});
check('reply is byte-identical to the reply for an unknown session id', () => {
  assert.strictEqual(r.callUnknown.status, 404, r.callUnknown.body);
  assert.strictEqual(r.callByB.contentType, r.callUnknown.contentType);
  assert.strictEqual(r.callByB.body, r.callUnknown.body);
});
check('the executor never ran and the idle clock of A\'s session was not touched', () => {
  assert.strictEqual(r.executedAfterB, 0);
  assert.strictEqual(r.callByB.clockAfter, STALE);
});

console.log('\n[session-ownership-express] 2. POST tools/list by a non-owner');
check('reply is byte-identical to the unknown-id discovery reply (200 with the tool list)', () => {
  assert.strictEqual(r.listByB.status, 200, r.listByB.body);
  assert.strictEqual(r.listUnknown.status, 200, r.listUnknown.body);
  assert.strictEqual(r.listByB.contentType, r.listUnknown.contentType);
  assert.strictEqual(r.listByB.body, r.listUnknown.body);
  const j = json(r.listByB.body);
  assert.ok(Array.isArray(j?.result?.tools), r.listByB.body);
  assert.strictEqual(j.result.tools[0]?.name, 'actual_accounts_list');
});
check('the idle clock of A\'s session was not touched', () => {
  assert.strictEqual(r.listByB.clockAfter, STALE);
});

console.log('\n[session-ownership-express] 3. GET by a non-owner');
check('reply is HTTP 400 with JSON-RPC -32000 "Transport not ready"', () => {
  assert.strictEqual(r.getByB.status, 400, String(r.getByB.body));
  const j = json(r.getByB.body);
  assert.ok(j, `not JSON: ${r.getByB.body}`);
  assert.strictEqual(j.error?.code, -32000);
  assert.strictEqual(j.error?.message, 'Transport not ready');
  assert.strictEqual(j.id, null);
});
check('reply is byte-identical to the reply for an unknown session id', () => {
  assert.strictEqual(r.getUnknown.status, 400, String(r.getUnknown.body));
  assert.strictEqual(r.getByB.contentType, r.getUnknown.contentType);
  assert.strictEqual(r.getByB.body, r.getUnknown.body);
});
check('the idle clock of A\'s session was not touched', () => {
  assert.strictEqual(r.getByB.clockAfter, STALE);
});
check('a pool entry with no transport gets the same reply and its idle clock is not touched', () => {
  assert.strictEqual(r.getOrphan.status, 400, String(r.getOrphan.body));
  assert.strictEqual(r.getOrphan.body, r.getUnknown.body);
  assert.strictEqual(r.getOrphan.clockAfter, STALE);
});

console.log('\n[session-ownership-express] 4. the owner is served');
check('A\'s tools/list is answered by the transport (200 with the list) and touches the clock', () => {
  assert.strictEqual(r.listByA.status, 200, r.listByA.body);
  const j = json(r.listByA.body);
  assert.strictEqual(j?.result?.tools?.[0]?.name, 'actual_accounts_list', r.listByA.body);
  assert.ok(r.listByA.clockAfter > STALE, `clock not touched: ${r.listByA.clockAfter}`);
});
check('A\'s tools/call reaches the executor and touches the clock', () => {
  assert.strictEqual(r.callByA.status, 200, r.callByA.body);
  assert.strictEqual(r.executedAfterA, 1);
  assert.ok(r.callByA.clockAfter > STALE, `clock not touched: ${r.callByA.clockAfter}`);
});
check('A\'s GET opens the event stream (200, text/event-stream) and touches the clock', () => {
  // 200 and the SSE content type, not merely "not 400": the touch runs before
  // handleRequest, so a transport that refused the owner (406, 405, 409) would
  // still advance the clock and a weaker assertion could not tell.
  assert.strictEqual(r.getByA.status, 200, String(r.getByA.body));
  assert.ok(String(r.getByA.contentType).includes('text/event-stream'), String(r.getByA.contentType));
  assert.ok(r.getByA.clockAfter > STALE, `clock not touched: ${r.getByA.clockAfter}`);
});

console.log('\n[session-ownership-express] 5. a session still initializing');
check('the stub captured the id and parked the initialize', () => {
  assert.ok(r.heldCaptured, 'getConnection was not parked');
});
check('B\'s GET on the initializing session gets the unknown-id reply and does not touch its clock', () => {
  assert.strictEqual(r.getHeld.status, 400, String(r.getHeld.body));
  assert.strictEqual(r.getHeld.contentType, r.getUnknown.contentType);
  assert.strictEqual(r.getHeld.body, r.getUnknown.body);
  assert.strictEqual(r.getHeld.clockAfter, STALE);
});
check('the parked initialize completes once released', () => {
  assert.strictEqual(r.heldInit.status, 200);
});

console.log('\n[session-ownership-express] 6. a session whose init failed (#550)');
check('the stub rejected A\'s initialize before seeding, and the id on the reply is the one it saw', () => {
  assert.ok(r.failInit.sidInStub, 'the rejecting stub was not reached');
  assert.strictEqual(r.failInit.sidOnReply, r.failInit.sidInStub, JSON.stringify(r.failInit));
  assert.strictEqual(r.failPoolHasEntry, false, 'a failed init must leave no pool entry');
});
check('B\'s tools/call with the failed id is byte-identical to the unknown-id reply (no cause)', () => {
  assert.strictEqual(r.failCallByB.status, 404, r.failCallByB.body);
  assert.strictEqual(json(r.failCallByB.body)?.error?.message, NOT_FOUND, r.failCallByB.body);
  assert.strictEqual(r.failCallByB.contentType, r.failUnknown.call.contentType);
  assert.strictEqual(r.failCallByB.body, r.failUnknown.call.body);
});
check('B\'s tools/list with the failed id is byte-identical to the unknown-id discovery reply (200)', () => {
  assert.strictEqual(r.failListByB.status, 200, r.failListByB.body);
  assert.strictEqual(r.failListByB.contentType, r.failUnknown.list.contentType);
  assert.strictEqual(r.failListByB.body, r.failUnknown.list.body);
  assert.ok(Array.isArray(json(r.failListByB.body)?.result?.tools), r.failListByB.body);
});
check('B\'s GET with the failed id is byte-identical to the unknown-id "Transport not ready" reply', () => {
  assert.strictEqual(r.failGetByB.status, 400, String(r.failGetByB.body));
  assert.strictEqual(json(r.failGetByB.body)?.error?.message, 'Transport not ready', r.failGetByB.body);
  assert.strictEqual(r.failGetByB.contentType, r.failUnknown.get.contentType);
  assert.strictEqual(r.failGetByB.body, r.failUnknown.get.body);
});
check('A, after B\'s requests, still gets the cause on tools/call (404, -32001, network_unreachable)', () => {
  assertCauseReplyPost(r.failCallByA, 7);
});
check('A still gets the cause on tools/list (the record beats the discovery shim for the owner)', () => {
  assertCauseReplyPost(r.failListByA, 8);
});
check('A still gets the cause on GET (400, -32000, network_unreachable)', () => {
  assertCauseReplyGet(r.failGetByA);
});

console.log('\n[session-ownership-express] 7. the same failed init under a static bearer (#550 negative case)');
const rb = run('bearer');
check('the bearer child ran scenario 6 only, with one rejecting initialize', () => {
  assert.strictEqual(rb.mode, 'bearer');
  assert.ok(rb.failInit.sidInStub, 'the rejecting stub was not reached');
  assert.strictEqual(rb.failInit.sidOnReply, rb.failInit.sidInStub, JSON.stringify(rb.failInit));
  assert.strictEqual(rb.failPoolHasEntry, false);
});
check('every caller is the one static principal, so the cause reply is served as before #550', () => {
  // The B helpers carry the same token here; this is the one-principal deployment.
  assertCauseReplyPost(rb.failCallByB, 7);
  assertCauseReplyPost(rb.failListByB, 8);
  assertCauseReplyGet(rb.failGetByB);
  assertCauseReplyPost(rb.failCallByA, 7);
  assertCauseReplyGet(rb.failGetByA);
});
check('an unknown id under the bearer still gets the plain unknown-id replies (the record is per id)', () => {
  assert.strictEqual(rb.failUnknown.call.status, 404);
  assert.strictEqual(json(rb.failUnknown.call.body)?.error?.message, NOT_FOUND);
  assert.strictEqual(rb.failUnknown.list.status, 200);
  assert.strictEqual(json(rb.failUnknown.get.body)?.error?.message, 'Transport not ready');
});

console.log('\n[session-ownership-express] 8. the same failed init with authentication disabled (#550 negative case)');
const rn = run('noauth');
check('the auth-disabled child ran scenario 6 only, with one rejecting initialize', () => {
  assert.strictEqual(rn.mode, 'noauth');
  assert.ok(rn.failInit.sidInStub, 'the rejecting stub was not reached');
  assert.strictEqual(rn.failInit.sidOnReply, rn.failInit.sidInStub, JSON.stringify(rn.failInit));
  assert.strictEqual(rn.failPoolHasEntry, false);
});
check('every caller is the anonymous principal (undefined), so the cause reply is served as before #550', () => {
  assertCauseReplyPost(rn.failCallByB, 7);
  assertCauseReplyPost(rn.failListByB, 8);
  assertCauseReplyGet(rn.failGetByB);
  assertCauseReplyPost(rn.failCallByA, 7);
  assertCauseReplyGet(rn.failGetByA);
});

console.log(`\n[session-ownership-express] Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

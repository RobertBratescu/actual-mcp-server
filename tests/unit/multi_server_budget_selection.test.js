// #571: with a multi-server budget registry, every operation must reach its budget on THAT
// budget's own Actual server.
//
// THE BUG, two paths. (1) A new HTTP session's first pool connection logged in to the DEFAULT
// server and downloaded the default budget, even when the session's active budget (a restored
// #189 preference) lives on another server. (2) The #390 precondition re-selected a budget by
// downloading it over the singleton's CURRENT login, comparing only sync ids, so a session whose
// budget lives on server Y asked server X for it whenever X was the last server logged in to.
//
// The fake upstream below models two servers that each hold their own budgets and refuse a
// download of a budget they do not have, which is what a real Actual server does.
//
// Run: node tests/unit/multi_server_budget_selection.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ACTUAL_SERVER_URL = 'http://x:5006';
process.env.ACTUAL_PASSWORD = 'pw-x';
process.env.ACTUAL_BUDGET_SYNC_ID = 'alpha-sync';
process.env.MCP_BRIDGE_DATA_DIR = mkdtempSync(join(tmpdir(), 'unit571-'));
// Small enough for case 16 to time a login out quickly; the fake upstream is instant otherwise.
process.env.ACTUAL_OP_TIMEOUT_MS = '400';
process.env.BUDGET_DEFAULT_NAME = 'Alpha';
process.env.BUDGET_1_NAME = 'Beta'; process.env.BUDGET_1_SYNC_ID = 'beta-sync';
process.env.BUDGET_2_NAME = 'Gamma'; process.env.BUDGET_2_SYNC_ID = 'gamma-sync';
process.env.BUDGET_2_SERVER_URL = 'http://y:5006'; process.env.BUDGET_2_PASSWORD = 'pw-gamma';
// Delta is a COPY of Alpha on server Y: same sync id, different server (case 8).
process.env.BUDGET_3_NAME = 'Delta'; process.env.BUDGET_3_SYNC_ID = 'alpha-sync';
process.env.BUDGET_3_SERVER_URL = 'http://y:5006'; process.env.BUDGET_3_PASSWORD = 'pw-gamma';

let passed = 0, failed = 0;
const log = (s) => process.stderr.write(s + '\n');
const describe = (l) => log(`\n[#571] ${l}`);
const check = (c, m) => { if (c) { log(`  PASS: ${m}`); passed++; } else { log(`  FAIL: ${m}`); failed++; } };

const SERVERS = {
  'http://x:5006': { password: 'pw-x', budgets: ['alpha-sync', 'beta-sync'] },
  'http://y:5006': { password: 'pw-gamma', budgets: ['gamma-sync', 'alpha-sync'] },
};

const apiMod = await import('@actual-app/api');
const api = apiMod.default || apiMod;

let server = null;   // the server the singleton is logged in to
let live = false;    // upstream's `internal`: set by a successful init, cleared by shutdown
let loaded = null;   // the budget the singleton holds
const calls = [];    // ['init', url, password] | ['close'] | ['shutdown'] | ['download', id]

let holdLogin = null; // case 16: a promise the next login waits on, to make it outlive its bound
let holdClose = null; // case 17: the same for the next close of an open budget
api.init = async ({ serverURL, password }) => {
  // The password is recorded too: "credentials never cross servers" (case 14) and the mutation
  // that swaps in ACTUAL_PASSWORD are only checkable if a row can see it.
  calls.push(['init', serverURL, password]);
  if (holdLogin) { const h = holdLogin; holdLogin = null; await h; calls.push(['landed', serverURL]); }
  // Upstream's init points the client at the server BEFORE it signs in, so a failed sign-in
  // leaves it on the new server with nothing proven (case 9 depends on this).
  server = serverURL;
  if (SERVERS[serverURL]?.password !== password) throw new Error(`Authentication failed on ${serverURL}`);
  live = true;
  return lib;
};
// Upstream's init returns its handler object, and `close-budget` closes the open budget WITHOUT
// syncing it and without dropping the login. Recorded only when a budget is open, so the rows
// read like the close they assert.
const lib = {
  send: async (name) => {
    if (name !== 'close-budget') throw new Error(`stub lib.send: unexpected ${name}`);
    if (!loaded) return 'ok';
    calls.push(['close']);
    if (holdClose) { const h = holdClose; holdClose = null; await h; calls.push(['closed']); }
    loaded = null;
    return 'ok';
  },
};
let traceSync = false; // cases 18 and 20: record syncs in `calls` only there, so other rows stay exact
api.sync = async () => { if (traceSync) calls.push(['sync']); };
// Upstream's shutdown syncs then closes the open budget, and is a no-op with nothing open. Only
// the pool's teardown may call it; a login that did (case 20 catches it) would sync a copy that
// can be stale against its data dir.
api.shutdown = async () => {
  if (!live) return;
  if (traceSync) calls.push(['sync']);
  calls.push(['shutdown']);
  live = false; server = null; loaded = null;
};
api.downloadBudget = async (id) => {
  calls.push(['download', id]);
  if (!SERVERS[server]?.budgets.includes(id)) throw new Error(`budget ${id} not found on ${server}`);
  loaded = id;
};
api.getBudgetMonths = async () => { if (!loaded) throw { type: 'APIError', message: 'No budget file is open' }; return ['2026-01']; };
let lastReadServer = null; // the server the singleton was logged in to at the last read
api.getAccounts = async () => { lastReadServer = server; return [{ id: `acct-in-${loaded}`, name: `acct-in-${loaded}` }]; };

const adapter = (await import('../../dist/src/lib/actual-adapter.js')).default;
const adapterNamed = await import('../../dist/src/lib/actual-adapter.js');
const { connectionPool } = await import('../../dist/src/lib/ActualConnectionPool.js');
const { connectToActualForSession } = await import('../../dist/src/actualConnection.js');
const { requestContext } = await import('../../dist/src/lib/requestContext.js');
const { setPreferredBudgetSyncId } = await import('../../dist/src/lib/budget-preference-store.js');
const { setApiLogin } = await import('../../dist/src/lib/apiState.js');
const { readFileSync, readdirSync, statSync } = await import('node:fs');

const since = (n) => calls.slice(n).map(c => c.join(':')).join(' ');

// Opens a session exactly as httpServer's onsessioninitialized does: inside the initialize
// request's context, which has the principal and ACL but no session id yet.
async function openSession(sid, principal, allowedBudgets = ['*']) {
  await requestContext.run({ sessionId: undefined, principal, allowedBudgets }, async () => {
    const budget = adapterNamed.initialBudgetForSession?.(sid);
    await connectToActualForSession(sid, budget && {
      serverUrl: budget.serverUrl, password: budget.password || '', syncId: budget.syncId,
      encryptionPassword: budget.encryptionPassword,
    });
  });
}
const accountsIn = async (sid, principal) => {
  try {
    const accts = await requestContext.run({ sessionId: sid, principal, allowedBudgets: ['*'] }, () => adapter.getAccounts());
    return accts[0]?.name;
  } catch (e) { return `ERROR ${e.message}`; }
};

// ---------------------------------------------------------------------------
describe('(1) path 1: a fresh session opens on its restored budget, on that budget\'s server');
{
  setPreferredBudgetSyncId('alice', 'gamma-sync');
  const mark = calls.length;
  await openSession('sess-alice', 'alice');
  check(since(mark) === 'init:http://y:5006:pw-gamma download:gamma-sync',
    `session open logged in to Gamma's server and downloaded Gamma (got "${since(mark)}")`);
  const got = await accountsIn('sess-alice', 'alice');
  check(got === 'acct-in-gamma-sync', `the first call read Gamma (got ${got})`);
}

// ---------------------------------------------------------------------------
describe('(2) path 1 default: no stored preference opens on the default budget and server');
{
  const mark = calls.length;
  await openSession('sess-bob', 'bob');
  check(since(mark) === 'close init:http://x:5006:pw-x download:alpha-sync',
    `session open used Alpha's server and budget (got "${since(mark)}")`);
}

// ---------------------------------------------------------------------------
describe('(3) path 2 cross-server: re-selection logs in to the wanted budget\'s server first');
{
  // The singleton is on X with Alpha (bob just opened). Alice's next call wants Gamma on Y.
  const mark = calls.length;
  const got = await accountsIn('sess-alice', 'alice');
  check(got === 'acct-in-gamma-sync', `Alice read Gamma after Bob moved the singleton to X (got ${got})`);
  check(since(mark) === 'close init:http://y:5006:pw-gamma download:gamma-sync',
    `re-selection closed Alpha, logged in to Y with Gamma's password, then downloaded (got "${since(mark)}")`);

  const mark2 = calls.length;
  const back = await accountsIn('sess-bob', 'bob');
  check(back === 'acct-in-alpha-sync', `Bob read Alpha after Alice moved the singleton to Y (got ${back})`);
  check(since(mark2) === 'close init:http://x:5006:pw-x download:alpha-sync',
    `re-selection closed Gamma, logged in to X with Alpha's password, then downloaded (got "${since(mark2)}")`);
}

// ---------------------------------------------------------------------------
describe('(4) path 2 same server: no new login when the wanted budget shares the current server');
{
  await connectionPool.getConnection('sess-carol');
  await requestContext.run({ sessionId: 'sess-carol', allowedBudgets: ['*'] }, () => adapter.switchBudget('Beta'));
  const mark = calls.length;
  const got = await accountsIn('sess-bob', 'bob');
  check(got === 'acct-in-alpha-sync', `Bob read Alpha after Carol loaded Beta (got ${got})`);
  check(since(mark) === 'download:alpha-sync', `re-selection on the same server only downloaded (got "${since(mark)}")`);
}

// ---------------------------------------------------------------------------
describe('(5) a matching budget on the matching server costs nothing');
{
  const mark = calls.length;
  await accountsIn('sess-bob', 'bob');
  await accountsIn('sess-bob', 'bob');
  check(calls.length === mark, `two same-budget calls made no upstream call (got "${since(mark)}")`);
}

// ---------------------------------------------------------------------------
describe('(6) switchBudget fast path: "same auth" as the session entry is not the singleton\'s login');
{
  // Carol's pool entry is on X (Beta). Alice moves the singleton to Y. Carol then switches to
  // Alpha, which shares her entry's auth, so the fast path runs: it must still log in to X.
  await accountsIn('sess-alice', 'alice');
  const mark = calls.length;
  let err = null;
  try {
    await requestContext.run({ sessionId: 'sess-carol', allowedBudgets: ['*'] }, () => adapter.switchBudget('Alpha'));
  } catch (e) { err = e.message; }
  check(err === null, `the fast-path switch succeeded (got ${err})`);
  check(since(mark) === 'close init:http://x:5006:pw-x download:alpha-sync',
    `the fast path logged in to X before downloading Alpha (got "${since(mark)}")`);
}

// ---------------------------------------------------------------------------
describe('(7) the wanted server rejects the login: ordinary error, no download, nothing trusted after');
{
  SERVERS['http://y:5006'].password = 'rotated';
  const failMark = calls.length;
  const failedRead = await accountsIn('sess-alice', 'alice');
  check(/Authentication failed/.test(String(failedRead)), `Alice's read failed on the bad login (got ${failedRead})`);
  // The trailing shutdown is the legacy cycle's cleanup of the failed operation; the close left
  // upstream initialised, so it is no longer a no-op, and with nothing open it closes nothing.
  check(since(failMark) === 'close init:http://y:5006:pw-gamma shutdown',
    `the failed re-selection closed the outgoing budget, tried Y, and downloaded nothing (got "${since(failMark)}")`);
  SERVERS['http://y:5006'].password = 'pw-gamma';

  // The failed init left the client pointed at Y with nothing proven. Bob, on X, must log in
  // again rather than trust a login record from before the failure.
  const mark = calls.length;
  const got = await accountsIn('sess-bob', 'bob');
  check(got === 'acct-in-alpha-sync', `Bob read Alpha after the failed login (got ${got})`);
  check(since(mark) === 'init:http://x:5006:pw-x download:alpha-sync',
    `Bob's call logged in again instead of trusting the unknown login (got "${since(mark)}")`);
  const back = await accountsIn('sess-alice', 'alice');
  check(back === 'acct-in-gamma-sync', `Alice recovered once the password was right again (got ${back})`);
}

// ---------------------------------------------------------------------------
describe('(8) the same sync id on two servers is not a match across servers');
{
  await connectionPool.getConnection('sess-dave');
  await requestContext.run({ sessionId: 'sess-dave', allowedBudgets: ['*'] }, () => adapter.switchBudget('Delta'));
  check(server === 'http://y:5006' && loaded === 'alpha-sync', `Dave holds the Y copy (server ${server}, loaded ${loaded})`);

  // Bob wants alpha-sync on X. The loaded sync id is equal, the server is not.
  const mark = calls.length;
  lastReadServer = null;
  await accountsIn('sess-bob', 'bob');
  check(lastReadServer === 'http://x:5006', `Bob's read ran against X, not Y's copy (got ${lastReadServer})`);
  check(since(mark) === 'close init:http://x:5006:pw-x download:alpha-sync',
    `the equal sync id did not pass the precondition (got "${since(mark)}")`);
}

// ---------------------------------------------------------------------------
describe('(9) a failed login inside switchBudget\'s fast path is not trusted afterwards');
{
  // Singleton on Y with Gamma (Alice). Carol (entry on X) fast-paths to Beta while X's password
  // is wrong: the login moves the client to X and fails. The records must not still say "Y,
  // Gamma", or Alice's next call would skip re-selection and read through the half-made X login.
  await accountsIn('sess-alice', 'alice');
  SERVERS['http://x:5006'].password = 'rotated';
  let err = null;
  try {
    await requestContext.run({ sessionId: 'sess-carol', allowedBudgets: ['*'] }, () => adapter.switchBudget('Beta'));
  } catch (e) { err = e.message; }
  SERVERS['http://x:5006'].password = 'pw-x';
  check(/Authentication failed/.test(String(err)), `the fast-path switch failed on the bad login (got ${err})`);

  lastReadServer = null;
  const got = await accountsIn('sess-alice', 'alice');
  check(got === 'acct-in-gamma-sync' && lastReadServer === 'http://y:5006',
    `Alice's next read re-selected Gamma on Y (got ${got} on ${lastReadServer})`);
}

// ---------------------------------------------------------------------------
describe('(10) single-server operations add no login: one init at session open, none after');
{
  const mark = calls.length;
  await openSession('sess-erin', 'erin');
  for (let i = 0; i < 3; i++) await accountsIn('sess-erin', 'erin');
  const inits = calls.slice(mark).filter(c => c[0] === 'init');
  check(inits.length === 1, `exactly one init, at session open (got "${since(mark)}")`);
  check(!since(mark).includes('close', since(mark).indexOf('download')),
    `no close after the session opened (got "${since(mark)}")`);
}

// ---------------------------------------------------------------------------
describe('(11) a stored preference the ACL denies falls back to the default');
{
  setPreferredBudgetSyncId('frank', 'gamma-sync');
  const mark = calls.length;
  await openSession('sess-frank', 'frank', ['alpha-sync', 'beta-sync']);
  const opened = since(mark);
  check(/init:http:\/\/x:5006:pw-x download:alpha-sync$/.test(opened),
    `the session opened on Alpha with Alpha's password (got "${opened}")`);
  check(!calls.slice(mark).some(c => c[0] === 'init' && c[2] === 'pw-gamma'),
    `no login carried Gamma's password (got "${opened}")`);
}

// ---------------------------------------------------------------------------
describe('(12) no principal (MCP_ALLOW_UNAUTHENTICATED) opens on the default');
{
  const mark = calls.length;
  await openSession('sess-anon', undefined);
  check(/init:http:\/\/x:5006:pw-x download:alpha-sync$/.test(since(mark)),
    `the session opened on Alpha with Alpha's password (got "${since(mark)}")`);
}

// ---------------------------------------------------------------------------
describe('(13) an unknown login never passes the precondition');
{
  // Live, Alpha loaded, on X: Bob's call would cost nothing. Forget the login only.
  await accountsIn('sess-bob', 'bob');
  setApiLogin(null);
  const mark = calls.length;
  const got = await accountsIn('sess-bob', 'bob');
  check(got === 'acct-in-alpha-sync', `Bob still read Alpha (got ${got})`);
  check(since(mark) === 'close init:http://x:5006:pw-x download:alpha-sync',
    `the unknown login forced a re-login to X before the read (got "${since(mark)}")`);
}

// ---------------------------------------------------------------------------
describe('(16) a login that times out keeps running: the next operation waits for it to settle');
{
  // withOpTimeout races and does not cancel, so Alice's timed-out login to Y lands AFTER her call
  // has failed and released the lock. If Bob's login to X ran first, that late landing would
  // re-point the client to Y underneath Bob's read. The abandoned login is registered with the
  // #393 registry, so Bob's lock acquisition settles it before his own login.
  await accountsIn('sess-bob', 'bob'); // singleton on X with Alpha
  let release;
  holdLogin = new Promise((res) => { release = res; });
  const failed = await accountsIn('sess-alice', 'alice');
  check(/timed out/.test(String(failed)), `Alice's read failed on the stalled login (got ${failed})`);

  const mark = calls.length;
  setTimeout(release, 100); // lands while Bob's call is already waiting for the lock
  lastReadServer = null;
  const got = await accountsIn('sess-bob', 'bob');
  const seq = since(mark);
  check(got === 'acct-in-alpha-sync' && lastReadServer === 'http://x:5006',
    `Bob read Alpha on X (got ${got} on ${lastReadServer})`);
  check(seq.indexOf('landed:http://y:5006') >= 0 && seq.indexOf('landed:http://y:5006') < seq.indexOf('init:http://x:5006'),
    `the abandoned login to Y settled before Bob logged in to X (got "${seq}")`);
  check(server === 'http://x:5006', `nothing re-pointed the client after Bob's read (on ${server})`);

  // Negative: the late landing recorded nothing, so Alice's next call logs in to Y again rather
  // than trusting a login no caller was waiting for.
  const mark2 = calls.length;
  const back = await accountsIn('sess-alice', 'alice');
  check(back === 'acct-in-gamma-sync' && since(mark2).includes('init:http://y:5006:pw-gamma'),
    `Alice recovered with a fresh login to Y (got ${back}, "${since(mark2)}")`);
}

// ---------------------------------------------------------------------------
describe('(17) a close that times out keeps running: the next operation waits for it to settle');
{
  // Upstream's close-budget clears the open budget only when it finishes. Alice's close of
  // Bob's Alpha times out and lands AFTER her call has failed; had Bob's re-login and download run
  // first, that late close would close the budget Bob just loaded, under his read. The abandoned
  // close is registered with the #393 registry in every deployment, so Bob's lock acquisition
  // settles it before his own login.
  await accountsIn('sess-bob', 'bob'); // singleton on X with Alpha
  let release;
  holdClose = new Promise((res) => { release = res; });
  const failed = await accountsIn('sess-alice', 'alice');
  check(/timed out/.test(String(failed)), `Alice's read failed on the stalled close (got ${failed})`);

  const mark = calls.length;
  setTimeout(release, 100); // lands while Bob's call is already waiting for the lock
  lastReadServer = null;
  const got = await accountsIn('sess-bob', 'bob');
  const seq = since(mark);
  check(got === 'acct-in-alpha-sync' && lastReadServer === 'http://x:5006',
    `Bob read Alpha on X (got ${got} on ${lastReadServer})`);
  check(seq.indexOf('closed') >= 0 && seq.indexOf('closed') < seq.indexOf('init:http://x:5006'),
    `the abandoned close settled before Bob logged in to X (got "${seq}")`);
  check(loaded === 'alpha-sync', `nothing closed Bob's budget after his read (holds ${loaded})`);

  // Negative: Alice's next call re-selects Gamma on Y, since her failed call recorded nothing.
  const mark2 = calls.length;
  const back = await accountsIn('sess-alice', 'alice');
  check(back === 'acct-in-gamma-sync' && since(mark2).includes('init:http://y:5006:pw-gamma'),
    `Alice recovered with a fresh login to Y (got ${back}, "${since(mark2)}")`);
}

// ---------------------------------------------------------------------------
describe('(18) a cross-server re-selection syncs the outgoing budget over the old login, then closes it');
{
  // The login's close does not sync (case 20), so the precondition's explicit sync is the only
  // one the outgoing budget gets, and it must run BEFORE the login moves to the other server.
  await accountsIn('sess-bob', 'bob'); // singleton on X with Alpha
  traceSync = true;
  try {
    const mark = calls.length;
    const got = await accountsIn('sess-alice', 'alice'); // Gamma, on Y
    check(got === 'acct-in-gamma-sync', `Alice read Gamma (got ${got})`);
    // startsWith: the read's own trailing sync of Gamma follows the download.
    check(since(mark).startsWith('sync close init:http://y:5006:pw-gamma download:gamma-sync'),
      `the outgoing budget synced once, on X, before the close and the login to Y (got "${since(mark)}")`);

    // Negative: a same-server re-selection has no close or login, and still syncs first.
    setPreferredBudgetSyncId('heidi', 'beta-sync');
    await openSession('sess-heidi', 'heidi');
    await accountsIn('sess-heidi', 'heidi'); // Beta, on X
    const mark2 = calls.length;
    const back = await accountsIn('sess-bob', 'bob'); // Alpha, on X
    check(back === 'acct-in-alpha-sync', `Bob read Alpha (got ${back})`);
    check(since(mark2) === 'sync download:alpha-sync',
      `a same-server re-selection still syncs the outgoing budget, then downloads (got "${since(mark2)}")`);
  } finally {
    traceSync = false;
  }
}

// ---------------------------------------------------------------------------
describe('(19) a session opened on an override never inherits the default encryption password');
{
  // Gamma configures no encryption password. The pool used to fall back to the DEFAULT budget's,
  // binding a budget from another server to a password it never had (and making a later
  // same-server switch compare unequal).
  process.env.ACTUAL_BUDGET_PASSWORD = 'default-enc';
  try {
    setPreferredBudgetSyncId('ivan', 'gamma-sync');
    await openSession('sess-ivan', 'ivan');
    const entry = connectionPool.connections.get('sess-ivan');
    check(entry?.syncId === 'gamma-sync', `Ivan's session opened on Gamma (got ${entry?.syncId})`);
    check(entry?.encryptionPassword === undefined,
      `the entry carries Gamma's own (absent) encryption password (got ${entry?.encryptionPassword})`);

    // Negative: a session opened without an override still takes the default budget's password.
    await connectToActualForSession('sess-judy');
    check(connectionPool.connections.get('sess-judy')?.encryptionPassword === 'default-enc',
      'a default-budget session keeps ACTUAL_BUDGET_PASSWORD');
  } finally {
    delete process.env.ACTUAL_BUDGET_PASSWORD;
  }
}

// ---------------------------------------------------------------------------
describe('(20) a session open closes the loaded budget without syncing it');
{
  // A copy loaded in memory can be stale against its own data dir: another process (the stdio
  // #270 regression runs one in the same container) wrote that budget meanwhile. Syncing it fails
  // "out-of-sync" and leaves the local copy permanently unopenable, which is what the v0.22.48
  // full run hit when the login closed through upstream's shutdown (sync, then close).
  await accountsIn('sess-bob', 'bob'); // singleton on X with Alpha
  setPreferredBudgetSyncId('kim', 'gamma-sync');
  traceSync = true;
  try {
    const mark = calls.length;
    await openSession('sess-kim', 'kim');
    check(since(mark) === 'close init:http://y:5006:pw-gamma download:gamma-sync',
      `the open closed Alpha without a sync, then logged in to Y (got "${since(mark)}")`);

    // Negative: the pool's own teardown still goes through upstream's shutdown, which syncs.
    const mark2 = calls.length;
    await api.shutdown();
    check(since(mark2) === 'sync shutdown', `the stub's shutdown records its sync (got "${since(mark2)}")`);
  } finally {
    traceSync = false;
  }
}

// ---------------------------------------------------------------------------
describe('(14) credentials never cross servers, over every row above');
{
  const crossed = calls.filter(c => c[0] === 'init' && c[2] !== { 'http://x:5006': 'pw-x', 'http://y:5006': 'pw-gamma' }[c[1]]);
  check(calls.filter(c => c[0] === 'init').length > 10, 'the rows above produced logins to check');
  check(crossed.length === 0, `every login paired a server with its own password (crossed: ${JSON.stringify(crossed)})`);
}

// ---------------------------------------------------------------------------
describe('(15) source guard: api.init is called only from the login chokepoint');
{
  // An api.init that skips initApiLoggedIn leaves the login unrecorded, and an unknown login is a
  // mismatch, so every later operation would log in again: the #127 burst, silently.
  const srcRoot = new URL('../../src/', import.meta.url).pathname;
  const CHOKEPOINT = 'lib/apiLogin.ts';
  const rawInits = (text) => text.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .filter(({ line }) => !/\bfunction\s+setApiLogin\b/.test(line)) // the definition, not a call
    .filter(({ line }) => /\bapi\.init\s*\(/.test(line) || /\bsetApiLogin\s*\(\s*[^n)]/.test(line));
  const walk = (dir) => readdirSync(dir).flatMap(f => {
    const full = join(dir, f);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
  const offenders = walk(srcRoot)
    .filter(f => !f.endsWith(CHOKEPOINT))
    .flatMap(f => rawInits(readFileSync(f, 'utf8')).map(({ n }) => `${f.slice(srcRoot.length)}:${n}`));
  check(offenders.length === 0, `no raw api.init or login record outside ${CHOKEPOINT} (got ${offenders.join(', ') || 'none'})`);
  check(rawInits(readFileSync(join(srcRoot, CHOKEPOINT), 'utf8')).length > 0, 'the guard finds the chokepoint\'s own api.init');
  check(rawInits('    await withOpTimeout(() => api.init({').length === 1
    && rawInits('  setApiLogin({ serverUrl, password });').length === 1
    && rawInits('  // api.init() in a comment').length === 0
    && rawInits('  setApiLogin(null);').length === 0,
    'the guard flags a raw init or login record and ignores comments and clears');
}

log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

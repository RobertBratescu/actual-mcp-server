// #572: several static Bearer tokens, each bound to a principal and a budget allow-list
// (MCP_STATIC_TOKENS). This file owns the rows the ticket names S1 to S9:
//
//   S1 restore isolation, S2 first permitted budget in registry order, S3 listings,
//   S4 denied switch, S5 the narrowed trusted-local skip, S9 interleaved read and write:
//   the adapter against a fake upstream, with each principal's list in requestContext
//   exactly as httpServer's authenticateRequest puts it there.
//   S6 resolver refusals, S7 config (Zod) refusals, S8 the matcher: pure.
//
// The HTTP half (who gets a list, 401s, session ownership) is
// tests/unit/httpServer_static_tokens.test.js.
//
// Run: node tests/unit/static_tokens.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ACTUAL_SERVER_URL = 'http://x:5006';
process.env.ACTUAL_PASSWORD = 'pw-x';
process.env.ACTUAL_BUDGET_SYNC_ID = 'alpha-sync';
process.env.MCP_BRIDGE_DATA_DIR = mkdtempSync(join(tmpdir(), 'unit572-'));
process.env.BUDGET_DEFAULT_NAME = 'Alpha';
process.env.BUDGET_1_NAME = 'Beta'; process.env.BUDGET_1_SYNC_ID = 'beta-sync';
process.env.BUDGET_2_NAME = 'Gamma'; process.env.BUDGET_2_SYNC_ID = 'gamma-sync';

let passed = 0, failed = 0;
const log = (s) => process.stderr.write(s + '\n');
const describe = (l) => log(`\n[#572] ${l}`);
const check = (c, m) => { if (c) { log(`  PASS: ${m}`); passed++; } else { log(`  FAIL: ${m}`); failed++; } };

// The principals of the ticket's scenarios, as resolveStaticTokens would resolve them.
const ALICE = ['alpha-sync'];
const BOB = ['alpha-sync', 'gamma-sync'];
const DAVE = ['gamma-sync', 'beta-sync']; // allow-list order is NOT registry order (S2)

// ---------------------------------------------------------------------------
// Fake upstream: one server holding all three budgets.
const apiMod = await import('@actual-app/api');
const api = apiMod.default || apiMod;
let loaded = null;
const calls = []; // ['init'] | ['close'] | ['download', id] | ['addTransactions', loaded, accountId]
const lib = { send: async (name) => { if (name === 'close-budget' && loaded) { calls.push(['close']); loaded = null; } return 'ok'; } };
api.init = async () => { calls.push(['init']); return lib; };
api.sync = async () => {};
api.shutdown = async () => { loaded = null; };
api.downloadBudget = async (id) => { calls.push(['download', id]); loaded = id; };
api.getBudgetMonths = async () => { if (!loaded) throw { type: 'APIError', message: 'No budget file is open' }; return ['2026-01']; };
api.getAccounts = async () => [{ id: `acct-in-${loaded}`, name: `acct-in-${loaded}` }];
api.addTransactions = async (accountId) => { calls.push(['addTransactions', loaded, accountId]); return 'ok'; };

const adapter = (await import('../../dist/src/lib/actual-adapter.js')).default;
const adapterNamed = await import('../../dist/src/lib/actual-adapter.js');
const { connectToActualForSession } = await import('../../dist/src/actualConnection.js');
const { requestContext } = await import('../../dist/src/lib/requestContext.js');
const { getPreferredBudgetSyncId } = await import('../../dist/src/lib/budget-preference-store.js');

const since = (n) => calls.slice(n).map(c => c.join(':')).join(' ');

// Opens a session as httpServer's onsessioninitialized does: inside the initialize request's
// context, which carries the principal and its list but no session id yet.
async function openSession(sid, principal, allowedBudgets) {
  await requestContext.run({ sessionId: undefined, principal, allowedBudgets }, async () => {
    const budget = adapterNamed.initialBudgetForSession(sid);
    await connectToActualForSession(sid, {
      serverUrl: budget.serverUrl, password: budget.password || '', syncId: budget.syncId,
      encryptionPassword: budget.encryptionPassword,
    });
  });
}
const as = (sid, principal, allowedBudgets, fn) => requestContext.run({ sessionId: sid, principal, allowedBudgets }, fn);
const accountsIn = async (sid, principal, list) => {
  try { return (await as(sid, principal, list, () => adapter.getAccounts()))[0]?.name; }
  catch (e) { return `ERROR ${e.message}`; }
};
const errorOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

// ---------------------------------------------------------------------------
describe('S1 a fresh session restores only its own principal\'s budget');
{
  await openSession('sess-bob', 'bob', BOB);
  await as('sess-bob', 'bob', BOB, () => adapter.switchBudget('Gamma'));
  check(getPreferredBudgetSyncId('bob') === 'gamma-sync', 'bob\'s switch stored bob\'s preference');
  await openSession('sess-alice', 'alice', ALICE);
  const got = await accountsIn('sess-alice', 'alice', ALICE);
  check(got === 'acct-in-alpha-sync', `alice's fresh session runs against Alpha (got ${got})`);
  check(getPreferredBudgetSyncId('alice') !== 'gamma-sync', 'alice never inherited bob\'s preference');
}

// ---------------------------------------------------------------------------
describe('S2 a restricted principal starts on its first permitted budget, in registry order');
{
  const opened = adapterNamed.initialBudgetForSession('sess-dave-probe');
  check(opened.syncId === 'alpha-sync', `with no list in context the default still applies (got ${opened.syncId})`);
  await openSession('sess-dave', 'dave', DAVE);
  const got = await accountsIn('sess-dave', 'dave', DAVE);
  check(got === 'acct-in-beta-sync', `dave's session runs against Beta, not Gamma or Alpha (got ${got})`);
  // A list naming nothing in the registry keeps the default, which the ACL then refuses.
  const err = await errorOf(() => as('sess-ghost', 'ghost', ['nope-sync'], () => adapter.getAccounts()));
  check(/^Budget ACL:/.test(String(err)), `a list with no registry match is refused, not widened (got ${err})`);
}

// ---------------------------------------------------------------------------
describe('S3 listings are filtered per principal');
{
  const names = (list) => as('sess-x', 'p', list, () => adapter.getBudgetRegistry()).map(b => b.name).join(',');
  check(names(ALICE) === 'Alpha', `alice sees Alpha only (got ${names(ALICE)})`);
  check(names(BOB) === 'Alpha,Gamma', `bob sees Alpha and Gamma (got ${names(BOB)})`);
  check(names(undefined) === 'Alpha,Beta,Gamma', `no list (legacy token) sees every budget (got ${names(undefined)})`);
  check(names([]) === '', `an empty list (the deny state) sees nothing (got "${names([])}")`);
}

// ---------------------------------------------------------------------------
describe('S4 a switch outside the list is the #570 not-found, and the active budget stays');
{
  const err = await errorOf(() => as('sess-alice', 'alice', ALICE, () => adapter.switchBudget('Gamma')));
  check(/Budget "Gamma" not found in configuration/.test(String(err)), `the switch fails as not found (got ${err})`);
  check(/Available budgets/.test(String(err)) && /"Alpha"/.test(String(err)) && !/Gamma"|Beta/.test(String(err).split('Available budgets')[1] ?? ''),
    `the available list names only "Alpha" (got ${err})`);
  const got = await accountsIn('sess-alice', 'alice', ALICE);
  check(got === 'acct-in-alpha-sync', `alice's active budget is still Alpha (got ${got})`);
  // Negative: a permitted target still switches.
  const ok = await errorOf(() => as('sess-bob', 'bob', BOB, () => adapter.switchBudget('Alpha')));
  check(ok === null, `bob may switch to Alpha (got ${ok})`);
  await as('sess-bob', 'bob', BOB, () => adapter.switchBudget('Gamma'));
}

// ---------------------------------------------------------------------------
describe('S5 a context with a list and NO session id is still checked');
{
  // The trusted-local skip is for stdio and startup: no session AND no list. A list with
  // nothing permitted in the registry resolves to the default, which must be refused.
  const err = await errorOf(() => as(undefined, 'ghost', ['nope-sync'], () => adapter.getAccounts()));
  check(/^Budget ACL:/.test(String(err)), `no-session context with a list is refused (got ${err})`);
  const denyAll = await errorOf(() => as(undefined, 'ghost', [], () => adapter.getAccounts()));
  check(/^Budget ACL:/.test(String(denyAll)), `no-session context with the empty deny list is refused (got ${denyAll})`);
  // Negative: no session and no list is still the trusted-local path.
  const local = await errorOf(() => requestContext.run({}, () => adapter.getAccounts()));
  check(local === null, `no session and no list is not checked (got ${local})`);
}

// ---------------------------------------------------------------------------
describe('S9 interleaved sessions: alice reads and writes Alpha after bob switched to Gamma');
{
  // Bob holds Gamma (S4 ended with his switch), so the singleton has Gamma loaded.
  await accountsIn('sess-bob', 'bob', BOB);
  check(loaded === 'gamma-sync', `bob's session left Gamma loaded (holds ${loaded})`);

  const mark = calls.length;
  const read = await accountsIn('sess-alice', 'alice', ALICE);
  check(read === 'acct-in-alpha-sync', `alice's read ran against Alpha (got ${read})`);
  check(since(mark).includes('download:alpha-sync'), `Alpha was loaded before alice's read (got "${since(mark)}")`);

  await accountsIn('sess-bob', 'bob', BOB); // bob moves the singleton back to Gamma
  const mark2 = calls.length;
  const werr = await errorOf(() => as('sess-alice', 'alice', ALICE,
    () => adapter.addTransactions({ account: 'acct-in-alpha-sync', date: '2026-10-21', amount: -500 })));
  check(werr === null, `alice's write succeeded (got ${werr})`);
  const seq = since(mark2);
  const dl = seq.indexOf('download:alpha-sync');
  const write = seq.indexOf('addTransactions:alpha-sync:acct-in-alpha-sync');
  check(dl >= 0 && write > dl, `Alpha was downloaded before the write, and the write landed in Alpha (got "${seq}")`);
  check(!seq.includes('addTransactions:gamma-sync'), `nothing was written to bob's Gamma (got "${seq}")`);
}

// ---------------------------------------------------------------------------
// Pure rows.
const {
  parseStaticTokensConfig, resolveStaticTokens, matchBearerToken, _matchBearerTokenWithCompareForTests,
  LEGACY_STATIC_PRINCIPAL, MIN_TOKEN_LENGTH,
} = await import('../../dist/src/auth/static-tokens.js');
const { configSchema } = await import('../../dist/src/config.js');

const REG = [{ name: 'Alpha', syncId: 'alpha-sync' }, { name: 'Beta', syncId: 'beta-sync' }, { name: 'Gamma', syncId: 'gamma-sync' }];
const TOK_A = 'a'.repeat(40);
const TOK_B = 'b'.repeat(40);
const LEGACY = 'l'.repeat(40);
const cfg = (o) => JSON.stringify(o);
const two = cfg({ alice: { tokenEnv: 'MCP_TOKEN_ALICE', budgets: ['Alpha'] }, bob: { tokenEnv: 'MCP_TOKEN_BOB', budgets: ['alpha', 'Gamma'] } });
const ENV = { MCP_TOKEN_ALICE: TOK_A, MCP_TOKEN_BOB: TOK_B };
const thrown = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

describe('S6 resolver: positive resolution, then every refusal by value, never with a token value');
{
  const entries = resolveStaticTokens(two, ENV, REG, LEGACY);
  check(entries.map(e => e.principal).join(',') === `alice,bob,${LEGACY_STATIC_PRINCIPAL}`, 'two principals, then the legacy token last');
  check(JSON.stringify(entries[1].allowedBudgets) === '["alpha-sync","gamma-sync"]', 'budget names resolve case-insensitively to sync ids');
  check(entries[2].allowedBudgets === undefined, 'the legacy token has no list (unrestricted, as before)');
  check(resolveStaticTokens(undefined, {}, REG, undefined).length === 0, 'nothing set resolves to no entries');

  const one = (budgets, tokenEnv = 'MCP_TOKEN_ALICE') => cfg({ alice: { tokenEnv, budgets } });
  const SHORT = 's'.repeat(MIN_TOKEN_LENGTH - 1);
  const SPACED = 'x'.repeat(20) + ' ' + 'x'.repeat(20);
  const rows = [
    ['unset tokenEnv', () => resolveStaticTokens(one(['Alpha']), {}, REG), /MCP_TOKEN_ALICE, which is unset or empty/, null],
    ['empty tokenEnv', () => resolveStaticTokens(one(['Alpha']), { MCP_TOKEN_ALICE: '' }, REG), /unset or empty/, null],
    ['short token', () => resolveStaticTokens(one(['Alpha']), { MCP_TOKEN_ALICE: SHORT }, REG), /shorter than 32/, SHORT],
    ['whitespace token', () => resolveStaticTokens(one(['Alpha']), { MCP_TOKEN_ALICE: SPACED }, REG), /RFC 6750/, SPACED],
    ['duplicate token', () => resolveStaticTokens(two, { MCP_TOKEN_ALICE: TOK_A, MCP_TOKEN_BOB: TOK_A }, REG), /MCP_TOKEN_BOB is not unique \(also used by MCP_TOKEN_ALICE\)/, TOK_A],
    ['token equal to MCP_SSE_AUTHORIZATION', () => resolveStaticTokens(one(['Alpha']), ENV, REG, TOK_A), /not unique \(also used by MCP_SSE_AUTHORIZATION\)/, TOK_A],
    ['unknown budget', () => resolveStaticTokens(one(['Nope']), ENV, REG), /references unknown budget "Nope"\. Available: "Alpha", "Beta", "Gamma"/, TOK_A],
    ['"*" in a budgets list', () => resolveStaticTokens(one(['*']), ENV, REG), /unknown budget "\*"/, TOK_A],
    ['a registry budget whose sync id is "*"', () => resolveStaticTokens(one(['Star']), ENV, [...REG, { name: 'Star', syncId: '*' }]), /unknown budget "Star"/, TOK_A],
  ];
  for (const [label, fn, re, secret] of rows) {
    const msg = thrown(fn);
    check(msg !== null && re.test(msg), `${label} is refused (got ${msg})`);
    if (secret) check(!String(msg).includes(secret), `${label}: the message carries no token value`);
  }
}

describe('S7 config refusals (Zod), on both transports');
{
  const base = { ACTUAL_SERVER_URL: 'http://localhost:5006', ACTUAL_PASSWORD: 'pw', ACTUAL_BUDGET_SYNC_ID: '00000000-0000-0000-0000-000000000000' };
  const refusal = (extra) => {
    const r = configSchema.safeParse({ ...base, ...extra });
    if (r.success) return null;
    return r.error.issues.filter(i => i.path.includes('MCP_STATIC_TOKENS')).map(i => i.message).join(' | ') || `other: ${JSON.stringify(r.error.issues)}`;
  };
  check(refusal({ MCP_STATIC_TOKENS: two }) === null, 'a valid value parses');
  check(refusal({ MCP_STATIC_TOKENS: '   ' }) === null, 'a blank value is the feature off');
  const rows = [
    ['invalid JSON', '{alice', /not valid JSON/],
    ['an array', '[]', /must be a JSON object/],
    ['an empty object', '{}', /defines no principals/],
    ['a bad principal name', cfg({ 'al ice': { tokenEnv: 'MCP_TOKEN_A', budgets: ['Alpha'] } }), /invalid principal name/],
    ['the reserved principal', cfg({ [LEGACY_STATIC_PRINCIPAL]: { tokenEnv: 'MCP_TOKEN_A', budgets: ['Alpha'] } }), /reserved for MCP_SSE_AUTHORIZATION/],
    ['an entry that is not an object', cfg({ alice: 'MCP_TOKEN_A' }), /must be an object/],
    ['tokenEnv ACTUAL_PASSWORD', cfg({ alice: { tokenEnv: 'ACTUAL_PASSWORD', budgets: ['Alpha'] } }), /"alice"\.tokenEnv must be a variable name starting with MCP_TOKEN_/],
    ['empty budgets', cfg({ alice: { tokenEnv: 'MCP_TOKEN_A', budgets: [] } }), /non-empty array/],
    ['a blank budget name', cfg({ alice: { tokenEnv: 'MCP_TOKEN_A', budgets: [' '] } }), /non-empty array/],
  ];
  for (const [label, value, re] of rows) {
    const msg = refusal({ MCP_STATIC_TOKENS: value });
    check(msg !== null && re.test(msg), `${label} is refused (got ${msg})`);
  }
  const oidc = refusal({ MCP_STATIC_TOKENS: two, AUTH_PROVIDER: 'oidc', OIDC_ISSUER: 'https://idp.test', OIDC_RESOURCE: 'https://host/http' });
  check(oidc !== null && /AUTH_PROVIDER/.test(oidc) && /MCP_STATIC_TOKENS/.test(oidc), `OIDC plus static tokens is refused naming both (got ${oidc})`);
  // Pure parser agrees with the schema on the shape.
  check(thrown(() => parseStaticTokensConfig(two)) === null, 'the parser accepts what the schema accepts');
}

describe('S8 matcher: exact match only, and every entry compared');
{
  const entries = resolveStaticTokens(two, ENV, REG, LEGACY);
  check(matchBearerToken(TOK_A, entries)?.principal === 'alice', 'alice\'s token matches alice');
  check(matchBearerToken(TOK_B, entries)?.principal === 'bob', 'bob\'s token matches bob');
  check(matchBearerToken(LEGACY, entries)?.principal === LEGACY_STATIC_PRINCIPAL, 'the legacy token matches static-bearer');
  check(matchBearerToken(TOK_A.slice(0, -1), entries) === undefined, 'a strict prefix matches nothing');
  check(matchBearerToken(TOK_A + 'a', entries) === undefined, 'an extension matches nothing');
  check(matchBearerToken('z'.repeat(40), entries) === undefined, 'an unknown token matches nothing');
  check(matchBearerToken(TOK_A, []) === undefined, 'no entries match nothing');
  let n = 0;
  const hit = _matchBearerTokenWithCompareForTests(TOK_A, entries, (a, b) => { n++; return a.equals(b); });
  check(hit?.principal === 'alice' && n === entries.length, `a first-entry match still compared all ${entries.length} entries (compared ${n})`);
}

log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

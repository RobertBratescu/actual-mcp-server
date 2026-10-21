// #571, stdio leg: a stdio process keeps the api singleton alive between tool calls (#419), so
// after actual_budgets_switch to a budget on ANOTHER server, the next call goes through the same
// #390 re-selection as a pooled HTTP session, and has to log in to that budget's own server.
//
// Separate from multi_server_budget_selection.test.js because stdio is a property of the PROCESS
// (MCP_STDIO_MODE, set before the adapter loads) and has no pool entries.
//
// Run: node tests/unit/multi_server_budget_selection_stdio.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MCP_STDIO_MODE = 'true';
process.env.ACTUAL_SERVER_URL = 'http://x:5006';
process.env.ACTUAL_PASSWORD = 'pw-x';
process.env.ACTUAL_BUDGET_SYNC_ID = 'alpha-sync';
process.env.MCP_BRIDGE_DATA_DIR = mkdtempSync(join(tmpdir(), 'unit571s-'));
process.env.BUDGET_DEFAULT_NAME = 'Alpha';
process.env.BUDGET_1_NAME = 'Gamma'; process.env.BUDGET_1_SYNC_ID = 'gamma-sync';
process.env.BUDGET_1_SERVER_URL = 'http://y:5006'; process.env.BUDGET_1_PASSWORD = 'pw-gamma';

let passed = 0, failed = 0;
const log = (s) => process.stderr.write(s + '\n');
const describe = (l) => log(`\n[#571 stdio] ${l}`);
const check = (c, m) => { if (c) { log(`  PASS: ${m}`); passed++; } else { log(`  FAIL: ${m}`); failed++; } };

const SERVERS = {
  'http://x:5006': { password: 'pw-x', budgets: ['alpha-sync'] },
  'http://y:5006': { password: 'pw-gamma', budgets: ['gamma-sync'] },
};

const apiMod = await import('@actual-app/api');
const api = apiMod.default || apiMod;

let server = null, live = false, loaded = null;
const calls = [];
// #574: with logins on two servers the password login is a fetch to <server>/account/login, and
// `api.init` only points the client (`password: ''`). Both record the same 'init' entry, so the
// rows read the same whichever path a login takes.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const m = /^(.*)\/account\/login$/.exec(String(url));
  if (!m || !SERVERS[m[1]]) return realFetch(url, opts);
  const { password } = JSON.parse(opts.body);
  calls.push(['init', m[1], password]);
  const ok = SERVERS[m[1]].password === password;
  const body = ok ? { status: 'ok', data: { token: `tok@${m[1]}` } } : { status: 'error', reason: 'invalid-password' };
  return new Response(JSON.stringify(body), { status: ok ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
};
api.init = async ({ serverURL, password }) => {
  server = serverURL;
  if (password) {
    calls.push(['init', serverURL, password]);
    if (SERVERS[serverURL]?.password !== password) throw new Error(`Authentication failed on ${serverURL}`);
  }
  live = true;
  return lib;
};
// Upstream's init returns its handler object; `close-budget` closes the open budget WITHOUT
// syncing it and keeps the login (#571 follow-up: a syncing close broke a stale local copy).
const lib = {
  send: async (name) => {
    if (name === 'subscribe-set-token') return;
    if (name !== 'close-budget') throw new Error(`stub lib.send: unexpected ${name}`);
    if (loaded) { calls.push(['close']); loaded = null; }
    return 'ok';
  },
};
api.shutdown = async () => { if (!live) return; calls.push(['shutdown']); live = false; server = null; loaded = null; };
api.sync = async () => {};
api.downloadBudget = async (id) => {
  calls.push(['download', id]);
  if (!SERVERS[server]?.budgets.includes(id)) throw new Error(`budget ${id} not found on ${server}`);
  loaded = id;
};
api.getBudgetMonths = async () => { if (!loaded) throw { type: 'APIError', message: 'No budget file is open' }; return ['2026-01']; };
let lastReadServer = null;
api.getAccounts = async () => { lastReadServer = server; return [{ id: `acct-in-${loaded}`, name: `acct-in-${loaded}` }]; };

const adapter = (await import('../../dist/src/lib/actual-adapter.js')).default;
const { switchBudget } = await import('../../dist/src/lib/actual-adapter.js');
const { requestContext } = await import('../../dist/src/lib/requestContext.js');
const { isApiInitialized } = await import('../../dist/src/lib/apiState.js');

const STDIO = { sessionId: 'stdio-unit-571', transport: 'stdio' };
const since = (n) => calls.slice(n).map(c => c.join(':')).join(' ');
const accounts = async () => {
  try { return (await requestContext.run(STDIO, () => adapter.getAccounts()))[0]?.name; }
  catch (e) { return `ERROR ${e.message}`; }
};

describe('(1) the first call logs in to the default server and keeps the singleton alive');
{
  const got = await accounts();
  check(got === 'acct-in-alpha-sync', `read Alpha (got ${got})`);
  check(since(0) === 'init:http://x:5006:pw-x download:alpha-sync', `one login to X (got "${since(0)}")`);
  check(isApiInitialized(), 'the singleton is still live after the call (#419 keep-alive)');
}

describe('(2) after a switch to a budget on another server, the next call logs in THERE');
{
  await requestContext.run(STDIO, () => switchBudget('Gamma'));
  const mark = calls.length;
  lastReadServer = null;
  const got = await accounts();
  check(got === 'acct-in-gamma-sync' && lastReadServer === 'http://y:5006',
    `read Gamma on Y (got ${got} on ${lastReadServer})`);
  check(since(mark) === 'close init:http://y:5006:pw-gamma download:gamma-sync',
    `closed Alpha, logged in to Y with Gamma's password, downloaded Gamma (got "${since(mark)}")`);
}

describe('(3) further calls on the same budget cost no login');
{
  const mark = calls.length;
  await accounts();
  await accounts();
  check(!calls.slice(mark).some(c => c[0] === 'init'), `no login (got "${since(mark)}")`);
}

log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

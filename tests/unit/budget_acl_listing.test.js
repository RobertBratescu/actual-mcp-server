// Regression test for #570: the budget ACL also covers the listing, import and
// error-text paths.
//
// _enforceBudgetAcl checks only the session's ACTIVE budget, so before #570 a
// restricted principal (allowedBudgets is a list of sync ids, not ["*"]) could:
//   1. list every configured budget via getBudgetRegistry (actual_budgets_list_available),
//   2. list every budget file on the upstream server via getBudgets (actual_budgets_get_all),
//   3. call importBudget (actual_budgets_import), which uploads the archive as a NEW
//      cloud file on the shared Actual server and loads it: a budget outside its ACL,
//   4. read foreign budget names and sync ids out of refusal and not-found errors.
//
// Cases:
//   1. restricted: getBudgetRegistry returns only permitted entries
//   2. ["*"], bearer, no-auth and no request context: full registry
//   3. OIDC with no allowedBudgets: getBudgetRegistry refuses (fail closed)
//   4. restricted: getBudgets returns only files whose groupId is permitted
//   5. ["*"], and the dynamic resolver's nested ["*"] inside a restricted context: every file
//   6. restricted: importBudget refused, logs acl_denied, never reaches upstream
//   7. ["*"]: importBudget reaches upstream
//   8. restricted switch miss lists only permitted budgets
//   9. restricted, out-of-ACL default budget: the refusal does not name it
//  10. restricted switch to a denied budget returns the unknown-name error (no existence oracle)

import { strict as assert } from 'node:assert';

process.env.ACTUAL_SERVER_URL = process.env.ACTUAL_SERVER_URL || 'http://test-server';
process.env.ACTUAL_PASSWORD = 'sentinel-pwd-DO-NOT-LEAK';
process.env.ACTUAL_BUDGET_SYNC_ID = 'alpha-sync';
process.env.BUDGET_DEFAULT_NAME = 'Alpha';
process.env.BUDGET_1_NAME = 'Beta';
process.env.BUDGET_1_SYNC_ID = 'beta-sync';
process.env.BUDGET_1_SERVER_URL = 'http://test-server';
process.env.BUDGET_1_PASSWORD = 'pwd-beta';

let passed = 0;
let failed = 0;
function describe(label) { console.log(`\n[budget-acl-listing] ${label}`); }
function check(cond, msg, details) {
  if (cond) { console.log(`  PASS: ${msg}`); passed++; }
  else { console.error(`  FAIL: ${msg}${details ? ' (' + details + ')' : ''}`); failed++; }
}

const warnCalls = [];
let upstreamImports = 0;

(async () => {
  const apiMod = await import('@actual-app/api');
  const apiDefault = (apiMod.default || apiMod);
  // Stubbed BEFORE the adapter is imported: it destructures the api at load time.
  apiDefault.sync = async () => {};
  // Upstream lists a synced budget twice (local copy and remote file), both carrying
  // the groupId, so the filter must keep both alpha rows and drop both beta rows.
  apiDefault.getBudgets = async () => [
    { id: 'Alpha-local', groupId: 'alpha-sync', name: 'Alpha' },
    { cloudFileId: 'alpha-cloud', groupId: 'alpha-sync', name: 'Alpha', state: 'remote' },
    { id: 'Beta-local', groupId: 'beta-sync', name: 'Beta' },
    { cloudFileId: 'beta-cloud', groupId: 'beta-sync', name: 'Beta', state: 'remote' },
    { id: 'Gamma-local', groupId: 'gamma-unregistered', name: 'Gamma' },
    { id: 'Local-only', name: 'Never uploaded' },
  ];
  const ALL_FILES = 6;
  apiDefault.importBudget = async () => { upstreamImports++; return { id: 'imported-id' }; };

  const logger = (await import('../../dist/src/logger.js')).default;
  const originalWarn = logger.warn.bind(logger);
  logger.warn = (msg) => { warnCalls.push(String(msg)); return originalWarn(msg); };

  const adapter = await import('../../dist/src/lib/actual-adapter.js');
  const { getBudgetRegistry, getBudgets, importBudget, switchBudget, _setSkipApiInitForTests, _setApiInitializedForTests } = adapter;
  const { connectionPool } = await import('../../dist/src/lib/ActualConnectionPool.js');
  const { requestContext } = await import('../../dist/src/lib/requestContext.js');
  const config = (await import('../../dist/src/config.js')).default;

  _setSkipApiInitForTests(true);
  _setApiInitializedForTests(true);
  config.AUTH_PROVIDER = 'oidc';

  function primePoolSession(sessionId) {
    connectionPool.connections.set(sessionId, {
      sessionId, initialized: true, lastActivity: Date.now(), dataDir: '/tmp/test',
    });
  }
  // Each session gets its own principal, so no #189 saved preference applies: the
  // active budget is the registry default (Alpha) unless a test switches.
  const inSession = (sessionId, allowedBudgets, fn) => {
    primePoolSession(sessionId);
    return requestContext.run({ sessionId, allowedBudgets, principal: `p-${sessionId}` }, fn)
      .finally(() => connectionPool.connections.delete(sessionId));
  };
  async function withProvider(provider, fn) {
    const saved = config.AUTH_PROVIDER;
    config.AUTH_PROVIDER = provider;
    try { return await fn(); } finally { config.AUTH_PROVIDER = saved; }
  }
  async function caught(fn) {
    try { await fn(); return undefined; } catch (e) { return e; }
  }
  const syncIds = list => list.map(b => b.syncId).sort();
  const BOTH = '["alpha-sync","beta-sync"]';

  describe('Case 1: restricted caller sees only permitted registry entries');
  {
    const reg = await inSession('s1', ['alpha-sync'], async () => getBudgetRegistry());
    assert.ok(Array.isArray(reg));
    check(JSON.stringify(syncIds(reg)) === '["alpha-sync"]', 'registry filtered to alpha-sync', JSON.stringify(syncIds(reg)));
  }

  describe('Case 2: unrestricted callers see the full registry');
  {
    const wild = await inSession('s2', ['*'], async () => getBudgetRegistry());
    check(JSON.stringify(syncIds(wild)) === BOTH, 'wildcard OIDC sees both', JSON.stringify(syncIds(wild)));
    for (const provider of ['none', 'bearer']) {
      const reg = await withProvider(provider, () => inSession(`s2-${provider}`, undefined, async () => getBudgetRegistry()));
      check(JSON.stringify(syncIds(reg)) === BOTH, `AUTH_PROVIDER=${provider} with no list sees both`, JSON.stringify(syncIds(reg)));
    }
    const noCtx = await withProvider('none', async () => getBudgetRegistry());
    check(JSON.stringify(syncIds(noCtx)) === BOTH, 'no request context (stdio/CLI) sees both', JSON.stringify(syncIds(noCtx)));
  }

  describe('Case 3: OIDC request with no allowedBudgets is refused the registry');
  {
    warnCalls.length = 0;
    const err = await caught(() => requestContext.run({ sessionId: 's3' }, async () => getBudgetRegistry()));
    check(!!err && /^Budget ACL: no allowedBudgets in request context/.test(err.message), 'refused, fail closed', err ? err.message : 'no error thrown');
    check(warnCalls.some(c => c.includes('acl_denied') && c.includes('no_allowed_budgets_in_context')), 'acl_denied warn logged with the reason');
  }

  describe('Case 4: restricted caller sees only permitted upstream files');
  {
    const files = await inSession('s4', ['alpha-sync'], async () => getBudgets());
    const ids = files.map(f => f.id ?? f.cloudFileId);
    check(JSON.stringify(ids) === '["Alpha-local","alpha-cloud"]', 'getBudgets keeps both alpha-sync rows and nothing else', JSON.stringify(ids));
  }

  describe('Case 5: wildcard callers see every upstream file');
  {
    const files = await inSession('s5', ['*'], async () => getBudgets());
    check(files.length === ALL_FILES, 'wildcard sees every file', String(files.length));
    // The dynamic ACL resolver (src/auth/budget-acl-dynamic.ts) nests this shape.
    const nested = await inSession('s5b', ['alpha-sync'], async () =>
      requestContext.run({ allowedBudgets: ['*'] }, () => getBudgets()));
    check(nested.length === ALL_FILES, "resolver's nested ['*'] sees every file", String(nested.length));
  }

  describe('Case 6: restricted caller cannot import');
  {
    warnCalls.length = 0;
    const before = upstreamImports;
    const err = await caught(() => inSession('s6', ['alpha-sync'], async () => importBudget(new Uint8Array([1]))));
    check(!!err && /^Budget ACL:.*actual_budgets_import/.test(err.message), 'refused with a Budget ACL error naming the tool', err ? err.message : 'no error thrown');
    check(upstreamImports === before, 'upstream importBudget was never called', `${upstreamImports - before} call(s)`);
    check(warnCalls.some(c => c.includes('acl_denied') && c.includes('actual_budgets_import')), 'acl_denied warn logged for the import');
  }

  describe('Case 7: wildcard caller can import');
  {
    const before = upstreamImports;
    let result;
    const err = await caught(async () => { result = await inSession('s7', ['*'], async () => importBudget(new Uint8Array([1]))); });
    check(!err && upstreamImports === before + 1 && result?.id === 'imported-id', 'import reached upstream once', err ? err.message : `${upstreamImports - before} call(s)`);
  }

  describe('Case 8: a restricted switch miss lists only permitted budgets');
  {
    const err = await caught(() => inSession('s8', ['alpha-sync'], async () => switchBudget('Nope')));
    check(!!err && err.message.includes('not found in configuration'), 'not-found error', err ? err.message : 'no error thrown');
    check(!!err && err.message.includes('"Alpha"') && !err.message.includes('Beta'), 'lists Alpha, not Beta', err?.message);
    const none = await caught(() => inSession('s8c', ['unknown-sync'], async () => switchBudget('Nope')));
    check(!!none && none.message.includes('Available budgets: none permitted for this session.'), 'a list matching no budget says so instead of an empty list', none?.message);
    const wild = await caught(() => inSession('s8b', ['*'], async () => switchBudget('Nope')));
    check(!!wild && wild.message.includes('"Alpha"') && wild.message.includes('"Beta"'), 'wildcard miss still lists both', wild?.message);
  }

  describe('Case 9: the refusal does not name the out-of-ACL default budget');
  {
    warnCalls.length = 0;
    const err = await caught(() => inSession('s9', ['beta-sync'], async () => getBudgets()));
    check(!!err && /^Budget ACL:/.test(err.message), 'refused with a Budget ACL error', err ? err.message : 'no error thrown');
    check(!!err && !err.message.includes('Alpha') && !err.message.includes('alpha-sync'), 'message names neither Alpha nor alpha-sync', err?.message);
    check(warnCalls.some(c => c.includes('acl_denied') && c.includes('alpha-sync')), 'the log still records the attempted budget');
  }

  describe('Case 10: a denied switch is indistinguishable from an unknown name');
  {
    warnCalls.length = 0;
    const err = await caught(() => inSession('s10', ['alpha-sync'], async () => switchBudget('beta')));
    const unknown = await caught(() => inSession('s10b', ['alpha-sync'], async () => switchBudget('beta-x')));
    check(!!err && !!unknown && err.message === unknown.message.replace('"beta-x"', '"beta"'),
      'same text as the not-found error for an unknown name', `${err?.message} | ${unknown?.message}`);
    check(!!err && !err.message.includes('Beta') && !err.message.includes('beta-sync'), 'message names neither Beta nor beta-sync', err?.message);
    check(warnCalls.some(c => c.includes('acl_denied') && c.includes('"attemptedBudget":"beta-sync"')), 'the log records attemptedBudget beta-sync');
  }

  console.log(`\n[budget-acl-listing] ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('[budget-acl-listing] crashed:', err);
  process.exit(1);
});

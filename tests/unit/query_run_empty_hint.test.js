// tests/unit/query_run_empty_hint.test.js  (#561)
//
// An empty actual_query_run result whose category.name, payee.name or account.name condition
// names an entity that does not exist carries a `hint` naming the value and the query that lists
// the exact names. A real entity with no matching rows, a query with no name condition, and any
// non-empty result stay exactly as they were: no `hint` key and, for the non-empty case, no
// entity lookup at all. Drives the REAL adapter (session disarmed) with a stubbed api.runQuery
// that answers by table, so every lookup the adapter makes is recorded and inspectable.
//
// Run: node tests/unit/query_run_empty_hint.test.js

process.env.MCP_STDIO_MODE = 'true';
process.env.ACTUAL_SERVER_URL = process.env.ACTUAL_SERVER_URL ?? 'http://localhost:5006';
process.env.ACTUAL_BUDGET_SYNC_ID = process.env.ACTUAL_BUDGET_SYNC_ID ?? '00000000-0000-0000-0000-000000000000';
process.env.ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD ?? 'stub-password-for-unit-test';

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok: ${label}`); passed++; }
  catch (err) { console.error(`  FAIL: ${label} -> ${err.message}`); failed++; }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// The fake budget. Equality is exact; LIKE is the case-insensitive % wildcard ActualQL applies.
const ENTITIES = {
  categories: ['Car Insurance', 'Groceries'],
  payees: ['Corner Shop', "O'Neil"],
  accounts: ['Checking'],
};
const likeToRegex = (p) => new RegExp('^' + String(p).split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
const matches = (name, cond) => {
  if (cond !== null && typeof cond === 'object') {
    if ('$like' in cond) return likeToRegex(cond.$like).test(name);
    if ('$eq' in cond) return name === cond.$eq;
    if ('$oneof' in cond) return cond.$oneof.some((v) => name === String(v).replace(/''/g, "'"));
    throw new Error(`stub: unexpected operator ${JSON.stringify(cond)}`);
  }
  return name === String(cond);
};

let mainRows = [];
let mainQuery = null;  // the serialized transactions query of the last run
let lookups = [];      // serialized lookup queries, in order
let failLookups = false;
let arrayShape = false;  // answer with a bare array instead of { data }

const apiMod = await import('@actual-app/api');
const apiDefault = (apiMod.default || apiMod);
apiDefault.sync = async () => {};
apiDefault.runQuery = async (query) => {
  const s = typeof query?.serialize === 'function' ? query.serialize() : query;
  if (s.table === 'transactions') { mainQuery = s; return arrayShape ? mainRows : { data: mainRows, dependencies: [] }; }
  lookups.push(s);
  if (failLookups) throw new Error(typeof failLookups === 'string' ? failLookups : 'stub lookup failure');
  const names = ENTITIES[s.table];
  if (!names) throw new Error(`stub: unexpected table ${s.table}`);
  const nameFilters = s.filterExpressions.map((f) => f.name).filter((v) => v !== undefined);
  const hits = names.filter((n) => nameFilters.every((c) => matches(n, c)));
  const found = hits.map((name) => ({ id: `id-${name}`, name }));
  return arrayShape ? found : { data: found, dependencies: [] };
};

const adapterMod = await import('../../dist/src/lib/actual-adapter.js');
adapterMod._setSkipApiInitForTests(true);
const adapter = adapterMod.default;

async function run(sql, rows = []) {
  mainRows = rows;
  lookups = [];
  return await adapter.runQuery(sql);
}

console.log('\n[#561] empty result, name condition matches no entity: hint');

await check('1. category.name = unknown: hint names the value and FROM categories', async () => {
  const r = await run("SELECT id FROM transactions WHERE category.name = 'Auto Insurance'");
  assert(Array.isArray(r.data) && r.data.length === 0, `data ${JSON.stringify(r.data)}`);
  assert(typeof r.hint === 'string', `no hint: ${JSON.stringify(r)}`);
  assert(r.hint.includes("'Auto Insurance'"), r.hint);
  assert(r.hint.includes('SELECT id, name FROM categories'), r.hint);
});

await check('2. category.name IN (known, unknown): hint names only the unknown one', async () => {
  const r = await run("SELECT id FROM transactions WHERE category.name IN ('Groceries', 'Grocerys')");
  assert(typeof r.hint === 'string', `no hint: ${JSON.stringify(r)}`);
  assert(r.hint.includes("'Grocerys'"), r.hint);
  assert(!r.hint.includes("'Groceries'"), `names the existing category: ${r.hint}`);
});

await check('2b. payee.name LIKE unmatched pattern: hint names it and FROM payees', async () => {
  const r = await run("SELECT id FROM transactions WHERE payee.name LIKE '%zzqx%'");
  assert(typeof r.hint === 'string' && r.hint.includes('zzqx') && r.hint.includes('SELECT id, name FROM payees'), JSON.stringify(r));
});

await check('2c. account.name unknown alongside a date condition: hint names FROM accounts', async () => {
  const r = await run("SELECT id FROM transactions WHERE account.name = 'Savngs' AND date >= '2025-01-01'");
  assert(typeof r.hint === 'string' && r.hint.includes("'Savngs'") && r.hint.includes('SELECT id, name FROM accounts'), JSON.stringify(r));
});

console.log('\n[#561] negative: no hint');

await check('3. category.name = existing, empty rows: no hint key', async () => {
  const r = await run("SELECT id FROM transactions WHERE category.name = 'Groceries' AND date >= '2030-01-01'");
  assert(Array.isArray(r.data) && r.data.length === 0, `data ${JSON.stringify(r.data)}`);
  assert(!('hint' in r), `hint present: ${r.hint}`);
  assert(lookups.length === 1, `expected one lookup, got ${lookups.length}`);
});

await check('3b. payee.name LIKE matching an existing payee, empty rows: no hint key', async () => {
  const r = await run("SELECT id FROM transactions WHERE payee.name LIKE '%corner%'");
  assert(!('hint' in r), `hint present: ${r.hint}`);
});

await check('3c. category.name IN (existing names), empty rows: no hint key, one lookup', async () => {
  const r = await run("SELECT id FROM transactions WHERE category.name IN ('Groceries', 'Car Insurance')");
  assert(!('hint' in r), `hint present: ${r.hint}`);
  assert(lookups.length === 1, `expected one lookup, got ${lookups.length}`);
});

await check('4. non-empty rows: no hint key and zero entity lookups', async () => {
  const r = await run("SELECT id FROM transactions WHERE category.name = 'Auto Insurance'", [{ id: 't1' }]);
  assert(r.data.length === 1, `data ${JSON.stringify(r.data)}`);
  assert(!('hint' in r), `hint present: ${r.hint}`);
  assert(lookups.length === 0, `made ${lookups.length} lookups`);
});

await check('4b. empty rows, no name condition: no hint key and zero lookups', async () => {
  const r = await run("SELECT id FROM transactions WHERE date >= '2099-01-01'");
  assert(!('hint' in r), `hint present: ${r.hint}`);
  assert(lookups.length === 0, `made ${lookups.length} lookups`);
});

// NOT LIKE on a joined name is refused by the query validator before it runs, so only != is
// reachable here; nameConditionLookups skips $notlike all the same.
await check('4c. != on a name is not looked up', async () => {
  const r = await run("SELECT id FROM transactions WHERE category.name != 'Nope' AND payee.name != 'Nope'");
  assert(!('hint' in r), `hint present: ${r.hint}`);
  assert(lookups.length === 0, `made ${lookups.length} lookups`);
});

await check('4d. a failing lookup returns the plain empty result, never an error', async () => {
  failLookups = true;
  try {
    const r = await run("SELECT id FROM transactions WHERE category.name = 'Auto Insurance'");
    assert(Array.isArray(r.data) && r.data.length === 0, `data ${JSON.stringify(r.data)}`);
    assert(!('hint' in r), `hint present: ${r.hint}`);
  } finally { failLookups = false; }
});

// A failed lookup logs by class only (errorLogFields, the #559 pattern): an upstream error that
// quotes the caller's value or query must reach no log line, and the caller still gets data: [].
await check("4e. a lookup error quoting the value is logged without it", async () => {
  const chunks = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  failLookups = "no such payee: O''Brien % in SELECT name FROM payees";
  process.stderr.write = (...a) => { chunks.push(String(a[0])); return true; };
  process.stdout.write = (...a) => { chunks.push(String(a[0])); return true; };
  let r;
  try {
    r = await run("SELECT id FROM transactions WHERE payee.name = 'O''Brien %'");
    await new Promise((res) => setTimeout(res, 30));
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
    failLookups = false;
  }
  const text = chunks.join('');
  assert(Array.isArray(r.data) && r.data.length === 0 && !('hint' in r), JSON.stringify(r));
  assert(text.includes('Empty-result name lookup failed'), `the failure was not logged at all: ${text.slice(0, 300)}`);
  assert(!text.includes('Brien') && !text.includes('SELECT name FROM payees'), `value or query logged: ${text.slice(0, 400)}`);
});

console.log('\n[#561] the value never reaches a query string');

await check("5. payee.name = 'O''Brien %': the lookup is a filter object carrying the main query's value", async () => {
  const r = await run("SELECT id FROM transactions WHERE payee.name = 'O''Brien %'");
  assert(lookups.length === 1, `expected one lookup, got ${lookups.length}`);
  const l = lookups[0];
  assert(l.table === 'payees', `table ${l.table}`);
  const mainValue = mainQuery.filterExpressions.find((f) => 'payee.name' in f)['payee.name'];
  assert(typeof mainValue === 'string' && mainValue.includes('Brien %'), `main filter ${JSON.stringify(mainValue)}`);
  const lookupValues = l.filterExpressions.filter((f) => 'name' in f).map((f) => f.name);
  assert(lookupValues.length === 1 && lookupValues[0] === mainValue, `lookup filter ${JSON.stringify(l.filterExpressions)}`);
  assert(typeof r.hint === 'string' && r.hint.includes('Brien %'), JSON.stringify(r));
});

await check("5b. IN ('O''Brien'): the lookup keeps $oneof and the hint shows the unescaped name", async () => {
  const r = await run("SELECT id FROM transactions WHERE payee.name IN ('O''Brien')");
  assert(lookups.length === 1, `expected one lookup, got ${lookups.length}`);
  const f = lookups[0].filterExpressions.find((e) => 'name' in e).name;
  assert(f && Array.isArray(f.$oneof) && f.$oneof[0] === "O''Brien", `lookup filter ${JSON.stringify(f)}`);
  assert(typeof r.hint === 'string' && r.hint.includes("'O'Brien'"), JSON.stringify(r));
});

await check("5c. IN ('O''Neil') naming an existing O'Neil: no hint, and the lookup keeps the doubled form", async () => {
  const r = await run("SELECT id FROM transactions WHERE payee.name IN ('O''Neil')");
  assert(lookups.length === 1, `expected one lookup, got ${lookups.length}`);
  const f = lookups[0].filterExpressions.find((e) => 'name' in e).name;
  assert(f && Array.isArray(f.$oneof) && f.$oneof[0] === "O''Neil", `lookup filter ${JSON.stringify(f)}`);
  assert(!('hint' in r), `false hint for an existing payee: ${r.hint}`);
});

await check("5d. IN ('O''Neil', 'Nobody'): the hint names only Nobody", async () => {
  const r = await run("SELECT id FROM transactions WHERE payee.name IN ('O''Neil', 'Nobody')");
  assert(typeof r.hint === 'string' && r.hint.includes("'Nobody'") && !r.hint.includes('Neil'), JSON.stringify(r));
});

await check('6. a 300-character value is echoed as at most 100 characters', async () => {
  const long = 'x'.repeat(300);
  const r = await run(`SELECT id FROM transactions WHERE category.name = '${long}'`);
  assert(typeof r.hint === 'string', `no hint: ${JSON.stringify(r).slice(0, 200)}`);
  const m = r.hint.match(/'(x+)'/);
  assert(m && m[1].length === 100, `echoed ${m ? m[1].length : 'none'} chars`);
});

console.log('\n[#561] review round 1 cases');

await check('7. an IN list of three values is ONE lookup, naming only the unknown ones', async () => {
  const r = await run("SELECT id FROM transactions WHERE category.name IN ('Groceries', 'Nope A', 'Nope B')");
  assert(lookups.length === 1, `expected one lookup, got ${lookups.length}`);
  assert(typeof r.hint === 'string' && r.hint.includes("'Nope A'") && r.hint.includes("'Nope B'") && !r.hint.includes("'Groceries'"), JSON.stringify(r));
});

await check("7b. IN ('Groceries', 'groceries'): the case variant is unmatched, as in the main query", async () => {
  const r = await run("SELECT id FROM transactions WHERE category.name IN ('Groceries', 'groceries')");
  assert(typeof r.hint === 'string' && r.hint.includes("'groceries'") && !r.hint.includes("'Groceries'"), JSON.stringify(r));
});

await check("8. a numeric-looking name ('12345') still gets a hint, for = and IN", async () => {
  const eq = await run("SELECT id FROM transactions WHERE category.name = '12345'");
  assert(typeof eq.hint === 'string' && eq.hint.includes("'12345'"), JSON.stringify(eq));
  const inl = await run("SELECT id FROM transactions WHERE category.name IN ('12345')");
  assert(typeof inl.hint === 'string' && inl.hint.includes("'12345'"), JSON.stringify(inl));
});

await check('9. a bare-array answer: an unknown name gets { data: [], hint }, an existing one stays []', async () => {
  arrayShape = true;
  try {
    const r = await run("SELECT id FROM transactions WHERE category.name = 'Auto Insurance'");
    assert(r && Array.isArray(r.data) && r.data.length === 0 && typeof r.hint === 'string', JSON.stringify(r));
    const ok = await run("SELECT id FROM transactions WHERE category.name = 'Groceries'");
    assert(Array.isArray(ok) && ok.length === 0, `existing name changed shape: ${JSON.stringify(ok)}`);
  } finally { arrayShape = false; }
});

console.log(`\n[#561] Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

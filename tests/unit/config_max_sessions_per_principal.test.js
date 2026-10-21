// tests/unit/config_max_sessions_per_principal.test.js
//
// #577: MAX_SESSIONS_PER_PRINCIPAL is optional. Unset or empty means no per-principal cap (an
// empty value in a compose file must not abort startup, which z.coerce would do: it turns '' into
// 0). Anything set must be a positive integer, and a bad value refuses startup with an error that
// names the variable. Tested through configSchema.safeParse, like config_https_validation.test.js,
// so the module-level process.exit in getConfig never runs.
//
// Run: node tests/unit/config_max_sessions_per_principal.test.js

import assert from 'assert';

const { configSchema } = await import('../../dist/src/config.js');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok: ${label}`); passed++; }
  catch (err) { console.error(`  FAIL: ${label} -> ${err.message}`); failed++; }
}

const base = {
  ACTUAL_SERVER_URL: 'http://localhost:5006',
  ACTUAL_PASSWORD: 'pw',
  ACTUAL_BUDGET_SYNC_ID: '00000000-0000-0000-0000-000000000000',
};

console.log('\n[config-max-sessions-per-principal]');

check('unset: valid, no per-principal cap', () => {
  const r = configSchema.safeParse({ ...base });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.MAX_SESSIONS_PER_PRINCIPAL, undefined);
});

check('empty string: valid, treated as unset', () => {
  const r = configSchema.safeParse({ ...base, MAX_SESSIONS_PER_PRINCIPAL: '' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.MAX_SESSIONS_PER_PRINCIPAL, undefined);
});

check('whitespace only: valid, treated as unset', () => {
  const r = configSchema.safeParse({ ...base, MAX_SESSIONS_PER_PRINCIPAL: '  ' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.MAX_SESSIONS_PER_PRINCIPAL, undefined);
});

check('a positive integer: valid, parsed to a number', () => {
  const r = configSchema.safeParse({ ...base, MAX_SESSIONS_PER_PRINCIPAL: '2' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.MAX_SESSIONS_PER_PRINCIPAL, 2);
});

for (const bad of ['0', '-1', '1.5', 'abc']) {
  check(`(negative) ${JSON.stringify(bad)}: rejected, naming the variable`, () => {
    const r = configSchema.safeParse({ ...base, MAX_SESSIONS_PER_PRINCIPAL: bad });
    assert.strictEqual(r.success, false);
    assert.match(JSON.stringify(r.error.issues), /MAX_SESSIONS_PER_PRINCIPAL/);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

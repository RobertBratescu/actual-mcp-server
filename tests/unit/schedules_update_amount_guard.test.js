// tests/unit/schedules_update_amount_guard.test.js
//
// #527: upstream merges a partial schedule update, so `amountOp` alone keeps the stored amount
// and `amount` alone keeps the stored op. adapter.updateSchedule therefore reads the stored
// row (inside the same write-queue drain) when exactly one of the two is supplied, and refuses
// a pair that cannot match ('isbetween' needs a { num1, num2 } range, every other op a number)
// BEFORE the write. The raw api is stubbed, so the real guard runs.
//
// Run via: npm run test:unit-js
// Or: node tests/unit/schedules_update_amount_guard.test.js   (needs `npm run build` first)

process.env.ACTUAL_SERVER_URL     = process.env.ACTUAL_SERVER_URL     ?? 'http://localhost:5006';
process.env.ACTUAL_BUDGET_SYNC_ID = process.env.ACTUAL_BUDGET_SYNC_ID ?? '00000000-0000-0000-0000-000000000000';
process.env.ACTUAL_PASSWORD       = process.env.ACTUAL_PASSWORD       ?? 'stub-password-for-unit-test';

let failures = 0;
const check = (cond, label, d = '') => {
  if (cond) console.log(`  ok: ${label}`);
  else { console.error(`  FAIL: ${label}${d ? ' (' + d + ')' : ''}`); failures++; }
};

const SID = '00000000-0000-0000-0000-000000000527';

const apiMod = await import('@actual-app/api');
const apiDefault = (apiMod.default || apiMod);

let stored = [];
let readCalls = 0;
let updateCalls = [];
let witness;
apiDefault.getSchedules = async () => { witness?.noteRead(); readCalls++; return stored; };
apiDefault.updateSchedule = async (id, fields, reset) => { witness?.noteWrite(); updateCalls.push({ id, fields, reset }); };
apiDefault.sync = async () => {};

const { makeCycleWitness } = await import('./helpers/write-cycle.mjs');
const [tool, adapterMod, errorsMod] = await Promise.all([
  import('../../dist/src/tools/schedules_update.js').then((m) => m.default),
  import('../../dist/src/lib/actual-adapter.js'),
  import('../../dist/src/lib/errors.js'),
]);
const { isPreflightRefusal } = errorsMod;
adapterMod._setSkipApiInitForTests(true);
witness = makeCycleWitness(adapterMod);

const run = async (row, input) => {
  stored = row === null ? [] : [{ id: SID, ...row }];
  readCalls = 0; updateCalls = []; witness.reset();
  try { await tool.call({ id: SID, ...input }); return null; } catch (e) { return e; }
};

const RANGE = { num1: -1, num2: -2 };

console.log('\n[#527] one field supplied: refused against the stored row, write never reached');
for (const [row, input, label] of [
  [{ amountOp: 'is', amount: -5000 }, { amountOp: 'isbetween' }, 'stored is/-5000 + amountOp isbetween'],
  [{ amountOp: 'isbetween', amount: RANGE }, { amount: -5000 }, 'stored isbetween/range + a number'],
  [{ amountOp: 'isbetween', amount: RANGE }, { amountOp: 'is' }, 'stored isbetween/range + amountOp is'],
  [{ amountOp: 'is', amount: -5000 }, { amount: { num1: 1, num2: 2 } }, 'stored is/-5000 + a range'],
  [{ amountOp: null, amount: -5000 }, { amount: { num1: 1, num2: 2 } }, 'stored null op (counts as is) + a range'],
  [{ amountOp: 'isbetween', amount: -5000 }, { amount: -6000 }, 'legacy stored scalar isbetween + a number'],
]) {
  const err = await run(row, input);
  check(isPreflightRefusal(err), `${label}: typed pre-flight refusal`, String(err?.message ?? err));
  check(updateCalls.length === 0, `${label}: rawUpdateSchedule NOT called`);
  check(witness.readInCycleNoWrite(), `${label}: the read ran inside the drain`, witness.describe());
}

console.log('\n[#527] the legacy repair message names both repairs');
{
  const err = await run({ amountOp: 'isbetween', amount: -5000 }, { amount: -6000 });
  const msg = String(err?.message ?? '');
  check(msg.includes('num1, num2') && msg.includes("'is'"), 'names the range form and amountOp is', msg);
  check(msg.includes(SID), 'names the schedule', msg);
}

console.log('\n[#527] accepted combinations reach the write once');
for (const [row, input, label] of [
  [{ amountOp: 'isbetween', amount: RANGE }, { amount: { num1: -2000, num2: -3000 } }, 'stored isbetween + a new range'],
  [{ amountOp: 'is', amount: -5000 }, { amount: -6000 }, 'stored is + a new number'],
  [{ amountOp: 'is', amount: 'weird' }, { amountOp: 'isbetween' }, 'an undecodable stored amount skips the check'],
  [{ amountOp: 'isbetween', amount: -5000 }, { amountOp: 'is' }, 'legacy scalar isbetween repaired with amountOp is'],
  [{ amountOp: 'isbetween', amount: -5000 }, { amount: { num1: -1, num2: -2 } }, 'legacy scalar isbetween repaired with a range'],
]) {
  const err = await run(row, input);
  check(err === null, `${label}: accepted`, String(err?.message ?? err));
  check(updateCalls.length === 1, `${label}: rawUpdateSchedule called once`);
  check(witness.sharedOneCycle(), `${label}: the read and the write shared one drain`, witness.describe());
}

console.log('\n[#527] no read when it cannot matter');
{
  let err = await run({ amountOp: 'isbetween', amount: -5000 }, { name: 'x' });
  check(err === null && readCalls === 0 && updateCalls.length === 1, 'neither field supplied: zero reads, one write', `reads=${readCalls}`);
  err = await run({ amountOp: 'is', amount: -5000 }, { amountOp: 'isbetween', amount: { num1: 1, num2: 2 } });
  check(err === null && readCalls === 0 && updateCalls.length === 1, 'both fields supplied: zero reads (the tool refinement covers it)', `reads=${readCalls}`);
}

console.log('\n[#527] schedule not found: the guard stands aside for upstream');
{
  const err = await run(null, { amount: -5000 });
  check(err === null && updateCalls.length === 1, 'no stored row: rawUpdateSchedule IS called, so upstream reports not-found', String(err?.message ?? err));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll schedules_update amount guard checks passed');
process.exit(0);

// tests/unit/rules_update_schedules_schema.test.js
//
// #486: the input schemas of actual_rules_update, actual_schedules_create and
// actual_schedules_update had no dedicated unit test, and #486 rewrote their describe
// text. This pins what each still ACCEPTS and REJECTS (Zod code and path), so a trim that
// loosens a constraint is red. The sibling cases for rules_create and
// rules_create_or_update live in their own test files.
//
// Run via: npm run test:unit-js
// Or: node tests/unit/rules_update_schedules_schema.test.js   (needs `npm run build` first)

process.env.ACTUAL_SERVER_URL     = process.env.ACTUAL_SERVER_URL     ?? 'http://localhost:5006';
process.env.ACTUAL_BUDGET_SYNC_ID = process.env.ACTUAL_BUDGET_SYNC_ID ?? '00000000-0000-0000-0000-000000000000';
process.env.ACTUAL_PASSWORD       = process.env.ACTUAL_PASSWORD       ?? 'stub-password-for-unit-test';

let failures = 0;
const check = (cond, label, d = '') => {
  if (cond) console.log(`  ok: ${label}`);
  else { console.error(`  FAIL: ${label}${d ? ' (' + d + ')' : ''}`); failures++; }
};

const ACC = '22222222-2222-2222-2222-222222222222';
const RID = '33333333-3333-3333-3333-333333333333';

const rulesUpdate = (await import('../../dist/src/tools/rules_update.js')).default;
const schedulesCreate = (await import('../../dist/src/tools/schedules_create.js')).default;
const schedulesUpdate = (await import('../../dist/src/tools/schedules_update.js')).default;
const { formatZodError } = await import('../../dist/src/lib/zod-error-format.js');

const where = (tool, input) => {
  const r = tool.inputSchema.safeParse(input);
  return r.success ? { ok: true, data: r.data, issues: [] } : { ok: false, data: null, issues: r.error.issues.map((i) => `${i.code} at ${i.path.join('.')}`) };
};
const rejectedWith = (tool, input, issue) => {
  const r = where(tool, input);
  return !r.ok && r.issues.length === 1 && r.issues[0] === issue;
};

// The issue strings of each branch of a single top-level invalid_union, or null.
const unionBranches = (tool, input) => {
  const r = tool.inputSchema.safeParse(input);
  if (r.success || r.error.issues.length !== 1 || r.error.issues[0].code !== 'invalid_union') return null;
  return r.error.issues[0].errors.map((b) => b.map((i) => `${i.code} at ${i.path.join('.')}`));
};

console.log('\n[#486] rules_update: op stays REQUIRED on every action (the shared ActionSchema defaults it)');
{
  const r = where(rulesUpdate, { id: RID, fields: { actions: [{ field: 'notes', value: 'x' }] } });
  check(!r.ok && r.issues.includes('invalid_type at fields.actions.0.op'), 'an action without op is invalid_type at fields.actions.0.op', r.issues.join(','));
  const ok = where(rulesUpdate, { id: RID, fields: { actions: [{ op: 'set', field: 'notes', value: 'x' }] } });
  check(ok.ok, 'an action with op parses', ok.issues.join(','));
  check(ok.ok && ok.data.fields.actions[0].op === 'set', 'op is carried through as given');
}

console.log('\n[#486] rules_update: other constraints');
{
  check(rejectedWith(rulesUpdate, { id: 'not-a-uuid', fields: {} }, 'invalid_format at id'), 'a non-uuid rule id is invalid_format at id');
  check(rejectedWith(rulesUpdate, { id: RID }, 'invalid_type at fields'), 'fields is required');
  check(rejectedWith(rulesUpdate, { id: RID, fields: { stage: 'default' } }, 'invalid_value at fields.stage'), 'stage "default" is invalid_value at fields.stage');
  check(rejectedWith(rulesUpdate, { id: RID, fields: { conditionsOp: 'xor' } }, 'invalid_value at fields.conditionsOp'), 'conditionsOp "xor" is invalid_value');
  const noStage = where(rulesUpdate, { id: RID, fields: { conditionsOp: 'or' } });
  check(noStage.ok && !('stage' in noStage.data.fields), 'omitting stage leaves no stage key (partial update)');
  const nul = where(rulesUpdate, { id: RID, fields: { stage: null } });
  check(nul.ok && nul.data.fields.stage === null, 'stage null is kept');
  check(rejectedWith(rulesUpdate, { id: RID, fields: { conditions: [{ field: 'notes', op: 'is' }] } }, 'invalid_union at fields.conditions.0.value'), 'a condition without value is rejected');
}

console.log('\n[#486] schedules_create: date and amount constraints');
{
  const base = { name: 'MCP-Schedule', account: ACC, amount: 100, date: '2026-01-05' };
  check(where(schedulesCreate, base).ok, 'a one-off schedule parses');
  const bad = where(schedulesCreate, { ...base, date: '2026-1-5' });
  check(!bad.ok && bad.issues.some((i) => i.startsWith('invalid_format at date')), 'date 2026-1-5 is invalid_format at date', bad.issues.join(','));
  check(rejectedWith(schedulesCreate, { ...base, amount: 12.5 }, 'invalid_union at amount'), 'amount 12.5 is invalid_union at amount (number or range, #527)');
  check(rejectedWith(schedulesCreate, { name: 'x', amount: 100 }, 'invalid_union at date'), 'date is required (invalid_union at date)');
  const missingBranches = unionBranches(schedulesCreate, { name: 'x', amount: 100 });
  check(missingBranches !== null && missingBranches.length > 0 && missingBranches.every((b) => b.length === 1 && b[0] === 'invalid_type at '), 'a missing date fails every union branch with invalid_type', JSON.stringify(missingBranches));
  check(rejectedWith(schedulesCreate, { ...base, amountOp: 'between' }, 'invalid_value at amountOp'), 'an unknown amountOp is invalid_value at amountOp');
  check(rejectedWith(schedulesCreate, { ...base, account: 'not-a-uuid' }, 'invalid_format at account'), 'a non-uuid account is invalid_format at account');
  const rec = where(schedulesCreate, { ...base, date: { frequency: 'monthly', start: '2026-01-05', endMode: 'never' } });
  check(rec.ok, 'a RecurConfig date parses');
  const badRec = where(schedulesCreate, { ...base, date: { frequency: 'hourly', start: '2026-01-05', endMode: 'never' } });
  check(rejectedWith(schedulesCreate, { ...base, date: { frequency: 'hourly', start: '2026-01-05', endMode: 'never' } }, 'invalid_union at date'), 'a RecurConfig with an unknown frequency is invalid_union at date');
  const badBranches = unionBranches(schedulesCreate, { ...base, date: { frequency: 'hourly', start: '2026-01-05', endMode: 'never' } });
  check(badBranches !== null && badBranches.some((b) => b.includes('invalid_value at frequency')), 'one union branch names invalid_value at frequency', JSON.stringify(badBranches));
  check(!badRec.ok, 'a RecurConfig with an unknown frequency is rejected');
  const defaults = where(schedulesCreate, base);
  check(defaults.ok && defaults.data.amountOp === 'is' && defaults.data.posts_transaction === false, 'amountOp defaults to is and posts_transaction to false');
}

console.log('\n[#486] schedules_update: constraints');
{
  const SID = '44444444-4444-4444-4444-444444444444';
  check(where(schedulesUpdate, { id: SID, name: 'x' }).ok, 'a partial update parses');
  check(rejectedWith(schedulesUpdate, { name: 'x' }, 'invalid_type at id'), 'id is required (invalid_type at id)');
  check(rejectedWith(schedulesUpdate, { id: SID, date: '2026-1-5' }, 'invalid_format at date'), 'date 2026-1-5 is invalid_format at date');
  check(rejectedWith(schedulesUpdate, { id: SID, amount: 12.5 }, 'invalid_union at amount'), 'amount 12.5 is invalid_union at amount (number or range, #527)');
  const nulls = where(schedulesUpdate, { id: SID, payee: null, account: null });
  check(nulls.ok && nulls.data.payee === null && nulls.data.account === null, 'payee and account accept null (clear)');
  const d = where(schedulesUpdate, { id: SID });
  check(d.ok && d.data.resetNextDate === false, 'resetNextDate defaults to false');
  check(rejectedWith(schedulesUpdate, { id: SID, amountOp: 'between' }, 'invalid_value at amountOp'), 'an unknown amountOp is invalid_value at amountOp');
}

// #527: isbetween takes a { num1, num2 } range, every other op a number. The refusals are
// custom issues at amount whose message names the fix.
const messageOf = (tool, input) => {
  const r = tool.inputSchema.safeParse(input);
  return r.success ? '' : r.error.issues.map((i) => i.message).join(' | ');
};
console.log('\n[#527] schedules_create: amount and amountOp must fit together');
{
  const base = { name: 'MCP-Schedule', account: ACC, date: '2026-01-05' };
  const refusals = [
    [{ amountOp: 'isbetween', amount: -5000 }, 'num1, num2', 'a scalar isbetween'],
    [{ amount: { num1: 1, num2: 2 } }, 'isbetween', 'a range with amountOp omitted (defaults to is)'],
    [{ amount: { num1: 1, num2: 2 }, amountOp: 'isapprox' }, 'isbetween', 'a range with isapprox'],
    [{ amount: { num1: 1, num2: 2 }, amountOp: 'is' }, 'isbetween', 'a range with is'],
    [{ amountOp: 'isbetween' }, 'num1, num2', 'isbetween with no amount'],
  ];
  for (const [extra, needle, label] of refusals) {
    check(rejectedWith(schedulesCreate, { ...base, ...extra }, 'custom at amount'), `${label} is custom at amount`, where(schedulesCreate, { ...base, ...extra }).issues.join(','));
    check(messageOf(schedulesCreate, { ...base, ...extra }).includes(needle), `${label}: the message names ${needle}`);
  }
  const range = where(schedulesCreate, { ...base, amountOp: 'isbetween', amount: { num1: -10000, num2: -5000 } });
  check(range.ok && range.data.amount.num1 === -10000 && range.data.amount.num2 === -5000, 'a range with isbetween parses and is carried through');
  const scalar = where(schedulesCreate, { ...base, amount: -5000 });
  check(scalar.ok && scalar.data.amountOp === 'is', 'a scalar with amountOp omitted still parses as is');
  for (const [bad, label] of [[{ num1: 1 }, 'a range missing num2'], [{ num1: 1.5, num2: 2 }, 'a fractional bound'], [{ num1: '1', num2: 2 }, 'a string bound']]) {
    check(rejectedWith(schedulesCreate, { ...base, amountOp: 'isbetween', amount: bad }, 'invalid_union at amount'), `${label} is invalid_union at amount`);
  }
  // A union failure must name both shapes, not the bare "Invalid input" (#527 review).
  for (const [bad, label] of [[12.5, 'a fractional number'], ['5000', 'a numeric string'], [{ num1: 1 }, 'a range missing num2']]) {
    const msg = messageOf(schedulesCreate, { ...base, amount: bad });
    check(msg.includes('integer cents') && msg.includes('num1, num2'), `${label}: the union message names both accepted shapes`, msg);
    check(messageOf(schedulesUpdate, { id: '44444444-4444-4444-4444-444444444444', amount: bad }).includes('integer cents'), `${label}: the update tool says the same`);
  }
  // What the caller sees is the central formatter's output, not the raw issue: pin that it
  // keeps the union message rather than rendering the branches.
  const r = schedulesCreate.inputSchema.safeParse({ ...base, amount: 12.5 });
  const formatted = r.success ? '' : formatZodError(r.error, schedulesCreate.inputSchema);
  check(formatted.includes('amount: amount must be integer cents'), 'the formatted error carries the union message at its path', formatted);
  const extraKey = where(schedulesCreate, { ...base, amountOp: 'isbetween', amount: { num1: 1, num2: 2, extra: 1 } });
  check(!extraKey.ok && extraKey.issues.includes('unrecognized_keys at amount'), 'an extra key in the range is unrecognized_keys at amount', extraKey.issues.join(','));
}

console.log('\n[#527] schedules_update: the input alone decides only when both fields are given');
{
  const SID = '44444444-4444-4444-4444-444444444444';
  check(rejectedWith(schedulesUpdate, { id: SID, amountOp: 'isbetween', amount: -5000 }, 'custom at amount'), 'both given, scalar isbetween is custom at amount');
  check(rejectedWith(schedulesUpdate, { id: SID, amountOp: 'is', amount: { num1: 1, num2: 2 } }, 'custom at amount'), 'both given, a range with is is custom at amount');
  check(where(schedulesUpdate, { id: SID, amountOp: 'isbetween', amount: { num1: 1, num2: 2 } }).ok, 'both given and matching parses');
  check(where(schedulesUpdate, { id: SID, amountOp: 'isbetween' }).ok, 'amountOp alone parses (the adapter guard decides against the stored row)');
  check(where(schedulesUpdate, { id: SID, amount: { num1: 1, num2: 2 } }).ok, 'amount alone parses (the adapter guard decides against the stored row)');
}

console.log('\n[#527] tools/list publishes the union for both tools');
{
  const { z } = await import('zod');
  for (const [name, tool] of [['schedules_create', schedulesCreate], ['schedules_update', schedulesUpdate]]) {
    const amount = z.toJSONSchema(tool.inputSchema).properties.amount;
    const branches = amount?.anyOf ?? [];
    const obj = branches.find((b) => b.type === 'object');
    check(branches.some((b) => b.type === 'integer'), `${name}: amount has an integer branch`, JSON.stringify(amount));
    check(obj && JSON.stringify([...(obj.required ?? [])].sort()) === '["num1","num2"]' && obj.additionalProperties === false, `${name}: amount has a strict { num1, num2 } branch`, JSON.stringify(obj));
    check(String(amount?.description ?? '').includes('isbetween'), `${name}: the amount description mentions isbetween`);
  }
}

// #478: monthly patterns, a strict recur config (an unknown key used to be STRIPPED, which is
// how `patterns` vanished while the create reported success) and an optional endMode.
console.log('\n[#478] recur config: patterns, strictness, optional endMode, on both tools');
{
  const SID = '44444444-4444-4444-4444-444444444444';
  const monthly = (patterns) => ({ frequency: 'monthly', start: '2026-11-03', patterns });
  for (const [name, tool, wrap] of [
    ['schedules_create', schedulesCreate, (date) => ({ name: 'MCP-Schedule', account: ACC, date })],
    ['schedules_update', schedulesUpdate, (date) => ({ id: SID, date })],
  ]) {
    for (const [pats, label] of [
      [[{ type: 'day', value: -1 }], 'the last day'],
      [[{ type: 'MO', value: 2 }], 'the second Monday'],
      [[{ type: 'FR', value: -1 }], 'the last Friday'],
      [[{ type: 'day', value: 1 }, { type: 'day', value: 15 }], 'days 1 and 15'],
      [[{ type: 'day', value: 31 }], 'day 31'],
    ]) {
      const r = where(tool, wrap(monthly(pats)));
      check(r.ok && JSON.stringify(r.data.date.patterns) === JSON.stringify(pats), `${name}: ${label} parses and keeps its patterns`, r.issues.join(', '));
    }
    check(where(tool, wrap({ frequency: 'weekly', start: '2026-11-03', patterns: [] })).ok, `${name}: patterns: [] on weekly is accepted (upstream reads every schedule back with it)`);
    const noEnd = where(tool, wrap({ frequency: 'monthly', start: '2026-11-03' }));
    check(noEnd.ok && !('endMode' in noEnd.data.date), `${name}: a config without endMode parses and gets no injected default`);
    for (const [date, issue, label] of [
      [{ frequency: 'weekly', start: '2026-11-03', patterns: [{ type: 'day', value: 1 }] }, 'custom at date.patterns', 'non-empty patterns on weekly'],
      [monthly([{ type: 'day', value: 0 }]), 'custom at date.patterns.0', 'day 0'],
      [monthly([{ type: 'day', value: 32 }]), 'custom at date.patterns.0', 'day 32'],
      [monthly([{ type: 'MO', value: 6 }]), 'custom at date.patterns.0', 'MO 6'],
      [monthly([{ type: 'TU', value: 0 }]), 'custom at date.patterns.0', 'a weekday value 0'],
      [monthly([{ type: 'day', value: 1 }, { type: 'day', value: 15 }, { type: 'MO', value: 6 }]), 'custom at date.patterns.2', 'a bad third pattern (the issue path names its index)'],
      [{ frequency: 'monthly', start: '2026-11-03', byMonthDay: 5 }, 'unrecognized_keys at date', 'an unknown key'],
      [monthly([{ type: 'day', value: 1, extra: 1 }]), 'unrecognized_keys at date.patterns.0', 'an unknown key in a pattern'],
    ]) {
      check(rejectedWith(tool, wrap(date), issue), `${name}: ${label} is ${issue}`, where(tool, wrap(date)).issues.join(', '));
    }
  }
  // The messages name the fix, and reach the caller through the central formatter.
  const fmt = (date) => {
    const r = schedulesCreate.inputSchema.safeParse({ name: 'x', account: ACC, date });
    return r.success ? '' : formatZodError(r.error, schedulesCreate.inputSchema);
  };
  check(fmt({ frequency: 'weekly', start: '2026-11-03', patterns: [{ type: 'day', value: 1 }] }).includes("only to frequency 'monthly'"), 'the weekly refusal names monthly');
  check(fmt(monthly([{ type: 'day', value: 0 }])).includes('1 to 31, or -1'), 'the day refusal names the range');
  check(fmt(monthly([{ type: 'FR', value: 6 }])).includes('1 to 5 (nth), or -1'), 'the weekday refusal names the range');
  check(fmt(monthly([{ type: 'day', value: 1 }, { type: 'MO', value: 6 }])).includes('MO 6'), 'the range refusal names the offending pattern');
  check(fmt({ frequency: 'monthly', start: '2026-11-03', byMonthDay: 5 }).includes('byMonthDay'), 'the unknown-key refusal names the key');
}

console.log('\n[#478] tools/list publishes patterns, an optional endMode and a closed recur object');
{
  const { z } = await import('zod');
  for (const [name, tool] of [['schedules_create', schedulesCreate], ['schedules_update', schedulesUpdate]]) {
    const date = z.toJSONSchema(tool.inputSchema).properties.date;
    const recur = (date?.anyOf ?? []).find((b) => b.type === 'object');
    check(recur?.properties?.patterns?.type === 'array' && String(recur.properties.patterns.description ?? '').includes('Monthly only'), `${name}: patterns is published with its description`, JSON.stringify(recur?.properties?.patterns));
    check(recur && !(recur.required ?? []).includes('endMode'), `${name}: endMode is not required`);
    check(recur?.additionalProperties === false, `${name}: the recur object is closed`);
  }
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll rules_update / schedules schema checks passed');
process.exit(0);

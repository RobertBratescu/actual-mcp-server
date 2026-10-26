// Unit tests for actual_reports_list and actual_reports_get.

process.env.ACTUAL_SERVER_URL = process.env.ACTUAL_SERVER_URL ?? 'http://localhost:5006';
process.env.ACTUAL_BUDGET_SYNC_ID = process.env.ACTUAL_BUDGET_SYNC_ID ?? '00000000-0000-0000-0000-000000000000';
process.env.ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD ?? 'stub-password-for-unit-test';

let failures = 0;
const pass = (label) => console.log(`  ok: ${label}`);
const fail = (label, d = '') => { console.error(`  FAIL: ${label}${d ? ' (' + d + ')' : ''}`); failures++; };
const check = (cond, label, d = '') => cond ? pass(label) : fail(label, d);

const REPORT_ID = '00000000-0000-4000-8000-0000000000c1';
const MISSING_ID = '00000000-0000-4000-8000-00000000abcd';

const ROW = {
  id: REPORT_ID,
  name: 'Monthly spending',
  start_date: '2023-06',
  end_date: '2023-09',
  date_static: 0,
  date_range: 'Last 3 months',
  mode: 'total',
  group_by: 'Category',
  sort_by: 'desc',
  balance_type: 'Expense',
  show_empty: 0,
  show_offbudget: 0,
  show_hidden: 0,
  show_uncategorized: 0,
  trim_intervals: 0,
  include_current: 0,
  graph_type: 'BarGraph',
  conditions: '[{"field":"category","op":"is"}]',
  conditions_op: 'and',
  metadata: { hidden: [] },
  interval: 'Monthly',
  color_scheme: 'not-json',
  tombstone: false,
  show_trend_lines: 1,
};

(async () => {
  const apiMod = await import('@actual-app/api');
  const apiDefault = (apiMod.default || apiMod);
  apiDefault.sync = async () => {};

  const [listTool, getTool, adapterMod] = await Promise.all([
    import('../../dist/src/tools/reports_list.js').then(m => m.default),
    import('../../dist/src/tools/reports_get.js').then(m => m.default),
    import('../../dist/src/lib/actual-adapter.js'),
  ]);
  const adapter = adapterMod.default;

  console.log('\n[reports_list] returns only the published list columns');
  {
    adapter.listCustomReports = async () => [ROW];
    const res = await listTool.call({});
    const item = res?.result?.[0];
    check(Array.isArray(res?.result) && res.result.length === 1, 'result is a one-item array');
    check(item?.id === REPORT_ID && item?.name === 'Monthly spending', 'id and name kept');
    check(item?.graph_type === 'BarGraph' && item?.end_date === '2023-09', 'graph and dates kept');
    check(item?.tombstone === undefined && item?.show_trend_lines === undefined && item?.conditions === undefined, 'list drops columns outside the list shape');
  }

  console.log('\n[reports_get] parses JSON columns and returns every schema column');
  {
    adapter.getCustomReport = async () => ROW;
    const res = await getTool.call({ id: REPORT_ID });
    const r = res?.result;
    check(r?.found === true, 'found is true');
    check(Array.isArray(r?.conditions) && r.conditions[0]?.op === 'is', 'conditions string parsed to an array');
    check(r?.metadata?.hidden && Array.isArray(r.metadata.hidden), 'metadata object kept');
    check(r?.color_scheme === 'not-json', 'invalid JSON left as text');
    check(r?.conditions_op === 'and' && r?.tombstone === false, 'plain columns kept');
    check(r?.show_trend_lines === undefined, 'columns outside the local schema are dropped');
    check(r?.message === undefined, 'no message when the report is found');
  }

  console.log('\n[reports_get] missing id returns found false and does not throw');
  {
    adapter.getCustomReport = async () => null;
    let threw = false;
    let res;
    try {
      res = await getTool.call({ id: MISSING_ID });
    } catch {
      threw = true;
    }
    const r = res?.result;
    check(!threw, 'does not throw');
    check(r?.found === false, 'found is false');
    check(r?.id === MISSING_ID, 'id echoed back');
    check(r?.report === null, 'report is null');
    check(typeof r?.message === 'string' && r.message.includes(MISSING_ID), 'message names the id');
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} reports test(s) FAILED`);
    process.exit(1);
  }
  console.log('All reports tests passed');
})();

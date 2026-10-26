/**
 * tests/reports.js
 *
 * Read-only custom report tests. A budget may have no saved reports; the list
 * call still has to return an array, and a missing id must come back found:false.
 *
 * Reads from context:  (none)
 * Writes to context:   (none)
 */

import { fail } from '../assert.js';

const MISSING_ID = '00000000-0000-4000-8000-00000000abcd';
const LIST_FIELDS = ['id', 'name', 'graph_type', 'mode', 'group_by', 'balance_type', 'interval', 'date_range', 'start_date', 'end_date'];

/**
 * @param {{ callTool: Function }} client
 * @param {object} _context
 */
export async function reportsTests(client, _context) {
  const { callTool } = client;
  console.log('\n-- Running REPORTS TESTS --');

  let firstId = null;

  try {
    const listed = await callTool('actual_reports_list', {});
    if (!Array.isArray(listed)) {
      fail(`reports_list: expected an array, got ${JSON.stringify(listed).slice(0, 200)}`);
    } else {
      const bad = listed.find((row) => !row || typeof row.id !== 'string' || typeof row.name !== 'string' || row.tombstone != null);
      if (bad) {
        fail(`reports_list: row missing id/name or included tombstone: ${JSON.stringify(bad).slice(0, 200)}`);
      } else if (listed.some((row) => LIST_FIELDS.some((field) => !(field in row)))) {
        fail('reports_list: a row omitted a published field');
      } else {
        console.log(`  ok reports_list: ${listed.length} saved report(s)`);
        firstId = listed[0]?.id ?? null;
      }
    }
  } catch (err) {
    fail(`reports_list: ${err.message}`);
  }

  if (firstId) {
    try {
      const got = await callTool('actual_reports_get', { id: firstId });
      const data = got?.result ?? got;
      const parsed = data?.conditions == null || typeof data.conditions === 'object';
      const meta = data?.metadata == null || typeof data.metadata === 'object';
      const colors = data?.color_scheme == null || typeof data.color_scheme === 'object';
      if (data?.found === true && data?.id === firstId && parsed && meta && colors && 'tombstone' in data) {
        console.log(`  ok reports_get [read-back]: ${data.name}`);
      } else {
        fail(`reports_get [read-back]: ${JSON.stringify(data).slice(0, 240)}`);
      }
    } catch (err) {
      fail(`reports_get [read-back]: ${err.message}`);
    }
  } else {
    console.log('  ok reports_get [read-back]: no saved reports to read');
  }

  try {
    const missing = await callTool('actual_reports_get', { id: MISSING_ID });
    const data = missing?.result ?? missing;
    if (data?.found === false && data?.id === MISSING_ID && data?.report === null && typeof data?.message === 'string' && data.message.includes(MISSING_ID)) {
      console.log('  ok reports_get [negative]: missing id returned found false');
    } else {
      fail(`reports_get [negative]: ${JSON.stringify(data).slice(0, 240)}`);
    }
  } catch (err) {
    fail(`reports_get [negative]: ${err.message}`);
  }
}

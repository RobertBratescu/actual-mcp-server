#!/usr/bin/env node
// #576: the settled zero-residue check that runs AFTER step 9 of deploy-and-test.sh.
//
// The integration runner asserts zero residue at the end of each transport run, but step 9
// (scripts/regression-270-stall.mjs and scripts/diag-270-http.mjs) runs after that, so a
// leak there was invisible to the release evidence: 236 REG270 categories had piled up
// before anyone looked. This re-asserts the same contract once step 9 is done.
//
// "Settled": the step 9 scripts delete through their own sessions (stall: a stdio
// server; diag: its HTTP session), and this check reads through a fresh HTTP session, so
// a delete that just committed can still be in flight to this listing. One immediate
// hard assertion would fail the gate on that lag, so a failed check waits and asks once
// more. The re-check cannot clear a stalled create that lands late: that object is real
// residue and fails the check. The check is only as good as the HTTP server's view of
// the budget, which holds while every harness writer syncs to the same Actual server.
//
// findResidue turns a failed listing into an empty one, so an unreadable budget (a
// rate-limited login, a session that never loaded) would read as "zero residue" and the
// release evidence would certify a budget nobody looked at. The two kinds step 9 writes
// (categories, groups) are probed first; an unreadable one is exit 1, never 0.
//
// Read only: it lists, it never deletes. Exit 0 = clean, 3 = residue (EXIT_RESIDUE),
// 1 = could not check.
//
// Env: MCP_HTTP_URL (default the local-env bearer endpoint), MCP_AUTH_TOKEN,
// RESIDUE_SETTLE_MS (default 10000).
import { createClient } from '../tests/manual/mcp-client.js';
import { assertNoResidue, EXIT_RESIDUE } from '../tests/manual/residue.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // local self-signed bearer cert on :3601
const URL_ = process.env.MCP_HTTP_URL || 'https://localhost:3601/http';
const TOKEN = process.env.MCP_AUTH_TOKEN || 'MCP-BEARER-LOCAL-a9f3k2p8q7x1m4n6';
const SETTLE_MS = Number(process.env.RESIDUE_SETTLE_MS || 10000);

const readableList = (r) => Array.isArray(r) || Array.isArray(r?.result) || Array.isArray(r?.groups);

/** The residue count, but only after both listings step 9 writes to answered; else exit 1. */
async function readableCheck(client) {
  for (const tool of ['actual_categories_get', 'actual_category_groups_get']) {
    if (!readableList(await client.callTool(tool, {}))) {
      console.error(`  post-step-9 residue check: ${tool} did not return a listing; the budget is unreadable`);
      process.exit(1);
    }
  }
  return assertNoResidue(client.callTool);
}

try {
  const client = createClient({ url: URL_ });
  client.setToken(`Bearer ${TOKEN}`);
  await client.initialize();
  let residue = await readableCheck(client);
  if (residue > 0) {
    console.log(`  Re-checking once after ${SETTLE_MS}ms (a just-committed delete may not be visible yet)...`);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    // Probed again: a session that expired during the wait must not turn a seen leak into 0.
    residue = await readableCheck(client);
  }
  process.exit(residue > 0 ? EXIT_RESIDUE : 0);
} catch (e) {
  console.error(`  post-step-9 residue check could not run: ${e?.message || e}`);
  process.exit(1);
}

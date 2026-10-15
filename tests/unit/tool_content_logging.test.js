// tests/unit/tool_content_logging.test.js  (#556)
// Tool arguments and results are the user's budget data and must never reach the logs,
// at any level. Drives the real callTool + createTool path at MCP_BRIDGE_LOG_LEVEL=debug
// with sentinel values in the arguments and the result, captures every byte written to
// stdout and stderr, and asserts no sentinel appears while the content-free record
// (tool, durationMs, outcome, bytes) does.

// Set BEFORE importing anything that loads the logger singleton.
process.env.MCP_STDIO_MODE = 'true';
process.env.LOG_FORMAT = 'json';
process.env.MCP_BRIDGE_LOG_LEVEL = 'debug';
process.env.ACTUAL_SERVER_URL = process.env.ACTUAL_SERVER_URL ?? 'http://localhost:5006';
process.env.ACTUAL_BUDGET_SYNC_ID = process.env.ACTUAL_BUDGET_SYNC_ID ?? '00000000-0000-0000-0000-000000000000';
process.env.ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD ?? 'dummy';

let failures = 0;
const out = (s) => process.stderr.write(s + '\n');
const pass = (l) => out(`  ✓ ${l}`);
const fail = (l, d = '') => { out(`  ✗ FAIL: ${l}${d ? ` (${d})` : ''}`); failures++; };
const ok = (cond, l, d = '') => (cond ? pass(l) : fail(l, d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Captures stdout and stderr while an async call runs, plus a short tail for the
// logger's own asynchronous writes.
const capture = async (fn) => {
  const chunks = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = (...a) => { chunks.push(String(a[0])); return true; };
  process.stdout.write = (...a) => { chunks.push(String(a[0])); return true; };
  let outcome;
  try {
    try { outcome = { value: await fn() }; } catch (error) { outcome = { error }; }
    await sleep(30);
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }
  return { text: chunks.join(''), ...outcome };
};

(async () => {
  const { z } = await import('zod');
  const { createTool } = await import('../../dist/src/lib/toolFactory.js');
  const manager = (await import('../../dist/src/actualToolsManager.js')).default;
  await manager.initialize();

  // Replace a PUBLISHED tool's definition with a stub, so the call passes the
  // publication check and runs the real createTool wrapper and callTool chokepoint.
  const NAME = 'actual_transactions_get';
  const stub = (handler) => manager.tools.set(NAME, createTool({
    name: NAME,
    description: 'stub',
    schema: z.object({ notes: z.string().optional(), amount: z.number().int().optional() }),
    handler,
  }));

  out('\n[#556] success: no result or argument content in any log line');
  {
    stub(async () => ({ payee: 'SENTINEL-555-R', notes: 'SENTINEL-555-R', amount: 555555 }));
    const r = await capture(() => manager.callTool(NAME, { notes: 'SENTINEL-555-A' }));
    ok(!r.error, 'the call succeeds', r.error && r.error.message);
    ok(r.value && r.value.result && r.value.result.payee === 'SENTINEL-555-R', 'the caller still receives the full result');
    ok(!r.text.includes('SENTINEL-555-R'), 'result sentinel absent from the logs', r.text.slice(0, 300));
    ok(!r.text.includes('SENTINEL-555-A'), 'argument sentinel absent from the logs');
    ok(!r.text.includes('555555'), 'result amount absent from the logs');
    const line = r.text.split('\n').find((l) => l.includes('[TOOL RESULT]'));
    let rec = null;
    // Structured fields land under `context` in a JSON record (src/logger.ts).
    try { rec = line ? JSON.parse(line).context ?? null : null; } catch { /* asserted below */ }
    ok(rec !== null, 'one [TOOL RESULT] JSON record with structured fields is logged');
    ok(rec && rec.tool === NAME, 'the record names the tool');
    ok(rec && typeof rec.durationMs === 'number', 'the record carries a numeric durationMs');
    ok(rec && rec.outcome === 'ok', 'the record carries outcome ok');
    ok(rec && typeof rec.bytes === 'number' && rec.bytes > 0, 'the record carries a numeric bytes');
  }

  out('\n[#556] handler failure: the error reaches the caller, no argument content is logged');
  {
    stub(async () => { throw new Error('upstream refused the write'); });
    const r = await capture(() => manager.callTool(NAME, { notes: 'SENTINEL-555-A', amount: 424242 }));
    ok(r.error && r.error.message === 'upstream refused the write', 'the error reaches the caller unchanged', r.error && r.error.message);
    ok(!r.text.includes('SENTINEL-555-A'), 'argument sentinel absent from the logs', r.text.slice(0, 300));
    ok(!r.text.includes('424242'), 'argument amount absent from the logs');
    ok(r.text.includes(NAME), 'the error record names the tool');
    const line = r.text.split('\n').find((l) => l.includes('[TOOL ERROR]'));
    let rec = null;
    try { rec = line ? JSON.parse(line).context ?? null : null; } catch { /* asserted below */ }
    ok(rec && rec.tool === NAME && rec.outcome === 'error' && typeof rec.durationMs === 'number',
      'the [TOOL ERROR] record carries tool, outcome error and durationMs', JSON.stringify(rec));
  }

  out('\n[#556] validation failure: the formatted error reaches the caller, no sentinel is logged');
  {
    stub(async () => ({ never: 'reached' }));
    const r = await capture(() => manager.callTool(NAME, { notes: 'SENTINEL-555-Z', amount: 'SENTINEL-555-Z' }));
    ok(r.error && /^Validation error: /.test(r.error.message), 'rejects with the #206 formatted message', r.error && r.error.message);
    ok(!r.text.includes('SENTINEL-555-Z'), 'sentinel absent from the logs', r.text.slice(0, 300));
  }

  out('\n[#556] source guard: no log call in src/ serializes a value into its message');
  {
    // A log call that JSON.stringify()s something is how content reached the logs at
    // sites 1, 4 and the rule update path. Ids and counts go in as plain fields instead.
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const walk = (d) => readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.ts') ? [p] : []);
    });
    const LOG_CALL = /\b(?:log|logger|\w+Log)\.(?:debug|info|warn|error)\(.*JSON\.stringify/;
    const hits = walk(fileURLToPath(new URL('../../src', import.meta.url))).flatMap((f) =>
      readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l]).filter(([, , l]) => LOG_CALL.test(l)));
    ok(hits.length === 0, 'no single-line log call stringifies a value', hits.map(([f, n]) => `${f}:${n}`).join(', '));
    ok(LOG_CALL.test("logger.debug(`[UPDATE RULE] ${JSON.stringify(rule)}`);"), 'the guard pattern matches the removed rule-update line');
  }

  out('');
  if (failures === 0) out('[#556] All tool content logging tests passed ✓');
  else { out(`[#556] ${failures} test(s) FAILED`); process.exit(2); }
})().catch((e) => { out(`[#556] crashed: ${e && e.stack}`); process.exit(2); });

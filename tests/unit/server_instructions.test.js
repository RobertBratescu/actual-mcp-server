// tests/unit/server_instructions.test.js  (#560)
//
// The initialize `instructions` string has ONE source, src/lib/serverInstructions.ts, built
// from the tools this process publishes. These checks pin:
//   1. the chat preset names both bootstrap tools and fits in 512 characters;
//   2. a toolset without actual_get_context never names it;
//   3. for every preset, every toolset and the full registry, in both read-only modes, every
//      actual_* name in the text is published, and the text fits in 512 characters;
//   4. read-only mode says so and names no write-capable tool;
//   5. a source scan: no legacy text and no non-spec `serverInstructions` key in src/;
//   6. a set without either bootstrap tool still yields a non-empty text naming no tool;
//   7. over real HTTP, initialize returns exactly the string passed to startHttpServer and
//      no `serverInstructions` key.
// The per-preset cases are unit-level only: the E2E stack runs the full registry.
//
// Run: node tests/unit/server_instructions.test.js

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripTsComments } from './helpers/source-text.js';

process.env.ACTUAL_SERVER_URL = process.env.ACTUAL_SERVER_URL ?? 'http://localhost:5006';
process.env.ACTUAL_BUDGET_SYNC_ID = process.env.ACTUAL_BUDGET_SYNC_ID ?? '00000000-0000-0000-0000-000000000000';
process.env.ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD ?? 'stub-password-for-unit-test';
delete process.env.AUTH_PROVIDER;
for (const k of ['MCP_TOOLSETS', 'MCP_TOOLS', 'MCP_READ_ONLY']) delete process.env[k];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok: ${label}`); passed++; }
  catch (err) { console.error(`  FAIL: ${label} -> ${err.message}`); failed++; }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const { buildServerInstructions } = await import('../../dist/src/lib/serverInstructions.js');
const { TOOLSETS, PRESETS, WRITE_CAPABLE, resolvePublishedToolNames } = await import('../../dist/src/lib/toolsets.js');
const manager = (await import('../../dist/src/actualToolsManager.js')).default;
await manager.initialize({ toolsets: 'all', tools: '', readOnly: false });
const registered = manager.getToolNames();
const published = (toolsets, readOnly) =>
  [...resolvePublishedToolNames(registered, { toolsets, tools: '', readOnly }).published];

// Its own regex: toolsets.test.js keeps presetReferenceProblems local.
const named = (text) => [...text.matchAll(/actual_[a-z0-9_]+/g)].map((m) => m[0]);
const LIMIT = 512;

console.log('\n[server-instructions] builder');

await check('1. chat preset names actual_get_context and actual_query_run, at most 512 chars', () => {
  const text = buildServerInstructions(PRESETS.chat, false);
  assert(text.includes('actual_get_context'), 'actual_get_context missing');
  assert(text.includes('actual_query_run'), 'actual_query_run missing');
  assert(text.length <= LIMIT, `length ${text.length}`);
});

await check('2. transactions toolset does not name actual_get_context', () => {
  assert(!TOOLSETS.transactions.includes('actual_get_context'), 'fixture assumption broke: transactions has get_context');
  assert(!buildServerInstructions(TOOLSETS.transactions, false).includes('actual_get_context'), 'named');
});

await check('3. every preset, toolset and the full registry, both modes: names only published tools, at most 512 chars', () => {
  const chatNames = named(buildServerInstructions(PRESETS.chat, false));
  assert(chatNames.length > 0, 'chat match set is empty, so this loop could pass vacuously');
  const cases = ['all', ...Object.keys(PRESETS), ...Object.keys(TOOLSETS)];
  const problems = [];
  for (const name of cases) {
    for (const readOnly of [false, true]) {
      let list;
      try { list = published(name, readOnly); } catch { continue; } // a read-only set that publishes nothing is a startup error, not a text
      const text = buildServerInstructions(list, readOnly);
      if (text.length > LIMIT) problems.push(`${name}/${readOnly}: ${text.length} chars`);
      for (const n of named(text)) if (!list.includes(n)) problems.push(`${name}/${readOnly}: names unpublished ${n}`);
    }
  }
  assert(problems.length === 0, problems.join('; '));
});

await check('4. read-only: says read-only and names no WRITE_CAPABLE tool', () => {
  const list = published('all', true);
  assert(list.every((n) => !WRITE_CAPABLE.has(n)), 'resolver published a writer under read-only');
  const text = buildServerInstructions(list, true);
  assert(text.includes('read-only'), 'read-only missing');
  const writers = named(text).filter((n) => WRITE_CAPABLE.has(n));
  assert(writers.length === 0, `names writers: ${writers.join(', ')}`);
  assert(!buildServerInstructions(list, false).includes('read-only'), 'read-only sentence present when not read-only');
});

await check('6. no bootstrap tool published: non-empty text naming no tool', () => {
  const text = buildServerInstructions(['actual_accounts_list'], false);
  assert(text.trim().length > 0, 'empty');
  assert(named(text).length === 0, `names ${named(text).join(', ')}`);
});

console.log('\n[server-instructions] source scan (comments stripped)');

await check('5. src/ has no legacy text and no non-spec serverInstructions key or literal', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(ROOT, 'src'));
  assert(files.length > 50, `only ${files.length} files scanned`);
  const hits = [];
  for (const f of files) {
    const code = stripTsComments(readFileSync(f, 'utf8'));
    const rel = f.slice(ROOT.length + 1);
    if (code.includes('proxy any API call')) hits.push(`${rel}: "proxy any API call"`);
    if (code.includes('Welcome to the Actual MCP server')) hits.push(`${rel}: legacy fallback`);
    if (/\bserverInstructions\s*:/.test(code)) hits.push(`${rel}: serverInstructions as a key`);
    if (/(['"`])serverInstructions\1/.test(code) || /\[\s*['"`]serverInstructions/.test(code)) hits.push(`${rel}: serverInstructions literal`);
  }
  assert(hits.length === 0, hits.join('; '));
});

console.log('\n[server-instructions] initialize over HTTP');

const { connectionPool } = await import('../../dist/src/lib/ActualConnectionPool.js');
connectionPool.getConnection = async (sid) => {
  connectionPool.connections.set(sid, {
    sessionId: sid, initialized: true, lastActivity: Date.now(),
    dataDir: '/nonexistent', serverUrl: 'http://localhost:5006', password: 'x', syncId: 'sync-default',
  });
  return connectionPool.connections.get(sid);
};
const { startHttpServer } = await import('../../dist/src/server/httpServer.js');
const { listener, cleanup } = await startHttpServer(
  {}, 0, '/http', {}, ['actual_accounts_list'], 'desc', 'instr', {}, 'test', '127.0.0.1', undefined,
);
try {
  if (!listener.listening) {
    await new Promise((res, rej) => { listener.once('listening', res); listener.once('error', rej); });
  }
  const { port } = listener.address();
  await check('7. initialize result.instructions equals the passed string, no serverInstructions key', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/http`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'instructions-test', version: '0' } } }),
    });
    const text = await r.text();
    const json = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:')).slice(5));
    assert(r.status === 200, `status ${r.status}`);
    assert(json.result && json.result.instructions === 'instr', `instructions ${JSON.stringify(json.result && json.result.instructions)}`);
    assert(!('serverInstructions' in json.result), 'serverInstructions key present');
  });
} finally {
  await new Promise((res) => listener.close(res));
  process.removeListener('SIGTERM', cleanup);
  process.removeListener('SIGINT', cleanup);
}

console.log(`\n[server-instructions] Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

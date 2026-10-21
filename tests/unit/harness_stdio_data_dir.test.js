// tests/unit/harness_stdio_data_dir.test.js
//
// #575: a harness stdio server started with `docker exec` must never run on the live
// HTTP server's /app/data. A second writer there was reproduced on 2026-10-21: every new
// session open failed out_of_sync afterwards until the budget's local copy was moved out
// by hand.
//
// Two halves:
//   1. scripts/lib/harness-stdio.mjs builds `-u app -e MCP_BRIDGE_DATA_DIR=<own dir>` and
//      refuses /app/data itself.
//   2. A source scan of scripts/*.mjs and tests/manual/*.js: every file that starts a stdio
//      server in a container goes through that helper, with no inline args array.
//
// Run: node tests/unit/harness_stdio_data_dir.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stdioExecArgs } from '../../scripts/lib/harness-stdio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok: ${label}`); passed++; }
  catch (err) { console.error(`  FAIL: ${label} -> ${err.message}`); failed++; }
}

console.log('\n[harness-stdio data dir]');

check('own data dir, as app, extra env before the container, --stdio tail', () => {
  const args = stdioExecArgs({ container: 'c', dataDir: '/tmp/mcp-reg270-data', env: { ACTUAL_OP_TIMEOUT_MS: '8000' } });
  assert.deepStrictEqual(args, [
    'exec', '-i', '-u', 'app',
    '-e', 'MCP_BRIDGE_DATA_DIR=/tmp/mcp-reg270-data',
    '-e', 'ACTUAL_OP_TIMEOUT_MS=8000',
    'c', 'node', 'dist/src/index.js', '--stdio',
  ]);
});

check('NEGATIVE: /app/data and /app/data/ are refused, naming /app/data', () => {
  for (const dataDir of ['/app/data', '/app/data/', '/app/data//']) {
    assert.throws(() => stdioExecArgs({ container: 'c', dataDir }), /\/app\/data/, `must refuse ${dataDir}`);
  }
});

check('NEGATIVE: an empty or relative dataDir is refused', () => {
  for (const dataDir of ['', undefined, 'tmp/x', './data']) {
    assert.throws(() => stdioExecArgs({ container: 'c', dataDir }), /absolute/, `must refuse ${JSON.stringify(dataDir)}`);
  }
});

check('a subdirectory of /app/data is isolated and accepted', () => {
  const args = stdioExecArgs({ container: 'c', dataDir: '/app/data/stdio-framing' });
  assert.ok(args.includes('MCP_BRIDGE_DATA_DIR=/app/data/stdio-framing'));
});

// ---- source scan ---------------------------------------------------------------------

// stdio-framing-check.mjs has its own buildDockerArgs({container, dataDir}) with `-u app`
// and its own dir, because it wraps the server in `sh -c` to read the sync id on the E2E
// stack; tests/unit/stdio_framing_check.test.js pins it.
const EXCLUDED = new Set(['scripts/stdio-framing-check.mjs']);

// An inline array literal that starts with 'exec' and contains '--stdio'.
const INLINE_ARRAY_RE = /\[\s*['"`]exec['"`][^\]]*['"`]--stdio['"`]/;
const IMPORTS_HELPER_RE = /from\s+['"][^'"]*harness-stdio\.mjs['"]/;

/**
 * null when `src` does not start a container stdio server; else the violation or 'ok'.
 * A file that imports the helper is a caller too: once switched over it no longer names
 * dist/src/index.js itself, and the "found the three callers" floor must still see it.
 */
function classify(src) {
  const inline = INLINE_ARRAY_RE.test(src);
  const fallback = /['"`]docker['"`]/.test(src) && src.includes('dist/src/index.js');
  if (!inline && !fallback && !IMPORTS_HELPER_RE.test(src)) return null;
  if (inline) return 'inline docker exec args array (use stdioExecArgs)';
  if (!IMPORTS_HELPER_RE.test(src)) return 'starts a container stdio server without importing scripts/lib/harness-stdio.mjs';
  // Importing is not using: a file could import prepareStdioDataDir and still build its
  // own args from a spread (`[...EXEC, C, 'node', 'dist/src/index.js', '--stdio']`).
  if (!/\bstdioExecArgs\(/.test(src)) return 'imports the helper but never calls stdioExecArgs';
  if (/['"`]--stdio['"`]/.test(src)) return "quoted '--stdio' outside the helper (build args with stdioExecArgs)";
  return 'ok';
}

function filesIn(dir, ext) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith(ext))
    .map((f) => `${dir}/${f}`);
}

check('every harness stdio site goes through the helper (scripts/*.mjs, tests/manual/*.js)', () => {
  const found = [];
  const bad = [];
  for (const rel of [...filesIn('scripts', '.mjs'), ...filesIn('tests/manual', '.js')]) {
    if (EXCLUDED.has(rel)) continue;
    const verdict = classify(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    if (verdict === null) continue;
    found.push(rel);
    if (verdict !== 'ok') bad.push(`${rel}: ${verdict}`);
  }
  assert.deepStrictEqual(bad, [], bad.join('\n'));
  // An empty scan must not pass: the three known callers are found.
  for (const caller of ['scripts/regression-270-stall.mjs', 'scripts/stdio-smoke.mjs', 'tests/manual/mcp-client-stdio.js']) {
    assert.ok(found.includes(caller), `scan did not find ${caller}; found: ${found.join(', ')}`);
  }
});

check('NEGATIVE: an args array split across lines is caught', () => {
  // The shape tests/manual/mcp-client-stdio.js had before #575.
  const src = [
    "const args = [",
    "  'exec', '-i',",
    "  '-u', 'app',",
    "  CONTAINER, 'node', 'dist/src/index.js', '--stdio',",
    "];",
    "transport = new StdioClientTransport({ command: 'docker', args });",
  ].join('\n');
  assert.match(classify(src), /inline/);
});

check('NEGATIVE: the fallback rule catches args the inline rule cannot see', () => {
  // No array literal starting with 'exec': only "names docker and dist/src/index.js" fires.
  const src = [
    "const args = ['-i', CONTAINER, 'node', 'dist/src/index.js', '--stdio'];",
    "args.unshift('exec');",
    "transport = new StdioClientTransport({ command: 'docker', args });",
  ].join('\n');
  assert.ok(!INLINE_ARRAY_RE.test(src), 'precondition: the inline rule misses this shape');
  assert.match(classify(src), /without importing/);
});

check('NEGATIVE: an inline array is refused even when the helper is imported', () => {
  const src = "import { stdioExecArgs } from './lib/harness-stdio.mjs';\n"
    + "const t = new StdioClientTransport({ command: 'docker', args: ['exec', '-i', C, 'node', 'dist/src/index.js', '--stdio'] });";
  assert.match(classify(src), /inline/);
});

check('NEGATIVE: importing the helper but spreading an own args array is refused', () => {
  const src = "import { prepareStdioDataDir, stdioExecArgs } from './lib/harness-stdio.mjs';\n"
    + "const unused = stdioExecArgs({ container: C, dataDir: '/tmp/x' });\n"
    + "const EXEC = ['exec', '-i'];\n"
    + "const t = new StdioClientTransport({ command: 'docker', args: [...EXEC, C, 'node', 'dist/src/index.js', '--stdio'] });";
  assert.ok(!INLINE_ARRAY_RE.test(src), 'precondition: the inline rule misses this shape');
  assert.match(classify(src), /--stdio/);
});

check('NEGATIVE: importing the helper without calling stdioExecArgs is refused', () => {
  const src = "import { prepareStdioDataDir } from './lib/harness-stdio.mjs';\n"
    + "const t = new StdioClientTransport({ command: 'docker', args: ARGS_FROM_ELSEWHERE });";
  assert.match(classify(src), /never calls stdioExecArgs/);
});

console.log(`\n[harness-stdio data dir] Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

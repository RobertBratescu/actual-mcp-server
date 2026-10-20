// Tests for the hardened static-Bearer auth path in httpServer.ts (#157).
//
// Two-pronged check:
//   1. Behavioural: the REAL matcher (src/auth/static-tokens.ts matchBearerToken, which
//      authenticateRequest calls since #572) accepts the legacy MCP_SSE_AUTHORIZATION
//      token and rejects a mismatch, a different length and an empty token without
//      throwing. Until #572 these rows exercised a copy of the comparison kept in this
//      file, which could not notice the production code changing.
//   2. Static-analysis log-leak guard: parse the source files and forbid any
//      debug-log line that includes token contents (the strings that were
//      logged before this fix landed). Removing the fix would re-introduce
//      one of these strings; the test catches it before merge.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../../src/server/httpServer.ts'), 'utf8');
const matcherSource = readFileSync(resolve(here, '../../src/auth/static-tokens.ts'), 'utf8');
const { resolveStaticTokens, matchBearerToken, LEGACY_STATIC_PRINCIPAL } = await import('../../dist/src/auth/static-tokens.js');

console.log('Running #157 bearer-auth hardening tests');

let passed = 0;
let failed = 0;
function ok(msg) {
  console.log(`  PASS: ${msg}`);
  passed++;
}
function bad(msg) {
  console.error(`  FAIL: ${msg}`);
  failed++;
}

// The entries startHttpServer builds when only MCP_SSE_AUTHORIZATION is set.
const LEGACY = 'MCP-BEARER-LOCAL-a9f3k2p8q7x1m4n6';
const entries = resolveStaticTokens(undefined, {}, [], LEGACY);
function compareToken(token) {
  return matchBearerToken(token, entries)?.principal === LEGACY_STATIC_PRINCIPAL;
}

// 1. Matching token: accepted as the legacy principal.
{
  const result = compareToken(LEGACY);
  if (result === true) ok('matching token returns the legacy principal');
  else bad(`matching token should match, got ${result}`);
}

// 2. Mismatched token, same length: rejected.
{
  const result = compareToken('MCP-BEARER-LOCAL-XXXXXXXXXXXXXXXXX');
  if (result === false) ok('same-length mismatched token is rejected');
  else bad(`same-length mismatch should be rejected, got ${result}`);
}

// 3. Different length (a strict prefix, and a longer one): rejected without throwing.
{
  let threw = false;
  let result;
  try {
    result = compareToken(LEGACY.slice(0, -1)) || compareToken(LEGACY + 'x');
  } catch (e) {
    threw = true;
  }
  if (result === false && !threw) ok('different-length tokens are rejected without throwing');
  else bad(`different-length tokens should be rejected without throwing, got ${result}, threw=${threw}`);
}

// 4. Empty token: rejected.
{
  const result = compareToken('');
  if (result === false) ok('empty token is rejected');
  else bad(`empty token should be rejected, got ${result}`);
}

// 5. Nothing configured: no entries, so nothing matches (authenticateRequest is not
//    reached at all then; this pins that an empty entry list cannot match).
{
  const none = resolveStaticTokens(undefined, {}, [], undefined);
  const result = none.length === 0 && matchBearerToken('something', none) === undefined;
  if (result === true) ok('no configured token: no entries and no match');
  else bad(`no configured token should give no entries and no match, got ${none.length} entries`);
}

// 6. Log-leak guard: forbid debug-log strings that previously dumped token contents.
//    Each string is a substring of one of the five lines removed by this fix.
//    Re-introducing any of them re-introduces a token leak in debug logs.
const FORBIDDEN_LOG_PATTERNS = [
  'Auth header received',
  'Extracted token',
  'Expected token',
  'Tokens equal',
  'Token hex dump',
];
for (const pat of FORBIDDEN_LOG_PATTERNS) {
  if (source.includes(pat) || matcherSource.includes(pat)) {
    bad(`Source file contains forbidden debug-log pattern: "${pat}". See #157.`);
  } else {
    ok(`source does not log "${pat}"`);
  }
}
// #572: the matcher module holds the tokens' digests; it must not log at all.
if (/^import .*(logger|loggerFactory)/m.test(matcherSource) || /console\.\w+\(/.test(matcherSource)) bad('src/auth/static-tokens.ts must not log (it handles tokens). See #572.');
else ok('src/auth/static-tokens.ts does not log');

// 7. The comparison is constant-time: since #572 it lives in src/auth/static-tokens.ts,
//    and authenticateRequest must go through that matcher rather than compare itself.
if (/import \{[^}]*timingSafeEqual[^}]*\} from 'node:crypto'/.test(matcherSource)) {
  ok('the matcher uses timingSafeEqual');
} else {
  bad('src/auth/static-tokens.ts must use timingSafeEqual; not found');
}
if (/matchBearerToken\(/.test(source)) {
  ok('httpServer.ts authenticates through matchBearerToken');
} else {
  bad('httpServer.ts must call matchBearerToken; not found');
}

// 8. Source no longer uses bare !== for the auth comparison.
//    More specific match: the prior code had `token !== config.MCP_SSE_AUTHORIZATION`.
if (source.includes('token !== config.MCP_SSE_AUTHORIZATION')) {
  bad('source still contains non-constant-time comparison `token !== config.MCP_SSE_AUTHORIZATION`. See #157.');
} else {
  ok('source no longer uses non-constant-time comparison for the bearer token');
}

console.log(`\n#157 results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

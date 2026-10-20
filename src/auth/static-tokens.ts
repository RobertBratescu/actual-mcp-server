// src/auth/static-tokens.ts
//
// #572: several static Bearer tokens, each bound to its own principal and budget
// allow-list (MCP_STATIC_TOKENS). Proposed and first implemented by @jospaquim in
// PR #569; reimplemented here on develop.
//
// Why: with the single MCP_SSE_AUTHORIZATION token every caller is the one
// principal 'static-bearer', so several MCP clients on one server share the #189
// per-principal budget preference and have no budget isolation without OIDC.
// Here each client presents its own token, which resolves to a principal (keys
// the #189 preference and session ownership) and to the request's allowedBudgets,
// enforced by the SAME chokepoints OIDC uses (_enforceBudgetAcl, switchBudget,
// the #570 listing and import guards). One enforcement path, two ways to fill it.
//
// Format (JSON object keyed by principal; budgets are registry NAMES):
//   MCP_STATIC_TOKENS={"alice":{"tokenEnv":"MCP_TOKEN_ALICE","budgets":["Home"]}}
// The token itself lives in the variable `tokenEnv` names, so the JSON can sit in
// a compose file while the secrets stay in the secret store.
//
// WHY THIS MODULE IMPORTS ONLY node:crypto. config.ts calls parseStaticTokensConfig
// at config-parse time (the budget-acl-parse.ts pattern, #551): importing the
// logger, config or the adapter from here would create an ESM cycle. It throws and
// never logs.
//
// ERROR-TEXT CONTRACT. A thrown message names principals, variable names and
// budget names only, never a token value.

import { createHash, timingSafeEqual } from 'node:crypto';

/** Principal reserved for the legacy MCP_SSE_AUTHORIZATION token. */
export const LEGACY_STATIC_PRINCIPAL = 'static-bearer';

/** Minimum token length: `openssl rand -hex 16` produces exactly this. */
export const MIN_TOKEN_LENGTH = 32;

const PRINCIPAL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Restricted to one family so a principal cannot point at ACTUAL_PASSWORD or any
// other secret, and so logger.ts can scrub every value of the family.
const TOKEN_ENV_RE = /^MCP_TOKEN_[A-Z0-9_]+$/;
// RFC 6750 b64token: '=' only as trailing padding, so whitespace and other
// characters a header cannot carry intact are refused at startup.
const B64TOKEN_RE = /^[A-Za-z0-9._~+/-]+=*$/;

/** One principal as written in MCP_STATIC_TOKENS, shape-checked. */
export interface StaticTokenConfig {
  tokenEnv: string;
  budgets: string[];
}

/** A credential the matcher compares against. */
export interface BearerEntry {
  /** Static principal, or LEGACY_STATIC_PRINCIPAL for MCP_SSE_AUTHORIZATION. */
  principal: string;
  /** Resolved sync ids; undefined for the legacy token (unrestricted, as before #572). */
  allowedBudgets?: string[];
  /** SHA-256 of the token. The token itself is not kept. */
  readonly digest: Buffer;
}

/** The registry shape resolution needs. */
export interface RegistryBudget {
  name: string;
  syncId: string;
}

/** True when the raw value is set (unset and blank both mean "feature off"). */
export function staticTokensConfigured(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== '';
}

/**
 * Shape check of MCP_STATIC_TOKENS, run by config.ts at startup on both
 * transports. Returns {} when unset or blank. Touches no environment and no
 * registry: that is resolveStaticTokens, HTTP only.
 */
export function parseStaticTokensConfig(raw: string | undefined): Record<string, StaticTokenConfig> {
  if (!staticTokensConfigured(raw)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw as string);
  } catch {
    throw new Error('MCP_STATIC_TOKENS is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP_STATIC_TOKENS must be a JSON object keyed by principal');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error('MCP_STATIC_TOKENS is set but defines no principals');
  }

  const out: Record<string, StaticTokenConfig> = {};
  for (const [principal, value] of entries) {
    if (!PRINCIPAL_RE.test(principal)) {
      throw new Error(`MCP_STATIC_TOKENS: invalid principal name "${principal}" (letters, digits, . _ -; at most 64)`);
    }
    if (principal === LEGACY_STATIC_PRINCIPAL) {
      throw new Error(`MCP_STATIC_TOKENS: principal "${LEGACY_STATIC_PRINCIPAL}" is reserved for MCP_SSE_AUTHORIZATION`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`MCP_STATIC_TOKENS: entry for "${principal}" must be an object {"tokenEnv", "budgets"}`);
    }
    const { tokenEnv, budgets } = value as { tokenEnv?: unknown; budgets?: unknown };
    if (typeof tokenEnv !== 'string' || !TOKEN_ENV_RE.test(tokenEnv)) {
      throw new Error(`MCP_STATIC_TOKENS: "${principal}".tokenEnv must be a variable name starting with MCP_TOKEN_ (A to Z, 0 to 9, _)`);
    }
    if (!Array.isArray(budgets) || budgets.length === 0 || !budgets.every((b) => typeof b === 'string' && b.trim() !== '')) {
      throw new Error(`MCP_STATIC_TOKENS: "${principal}".budgets must be a non-empty array of budget names`);
    }
    out[principal] = { tokenEnv, budgets: [...(budgets as string[])] };
  }
  return out;
}

function digestOf(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Resolve MCP_STATIC_TOKENS against the environment and the budget registry, and
 * build the matcher's entries: one per static principal, plus the legacy token
 * when set. Called by startHttpServer before it binds, so a refusal stops startup
 * the way an unreadable TLS key does. Returns [] when neither token source is set.
 */
export function resolveStaticTokens(
  raw: string | undefined,
  env: Record<string, string | undefined>,
  registry: Iterable<RegistryBudget>,
  legacyToken: string | undefined,
): BearerEntry[] {
  const parsed = parseStaticTokensConfig(raw);

  const byName = new Map<string, RegistryBudget>();
  for (const b of registry) byName.set(b.name.toLowerCase(), b);

  const entries: BearerEntry[] = [];
  // Uniqueness is checked on digests: equal digests are equal tokens, and no
  // token value has to be held to compare them.
  const seen = new Map<string, string>();
  if (legacyToken) seen.set(digestOf(legacyToken).toString('hex'), 'MCP_SSE_AUTHORIZATION');

  for (const [principal, { tokenEnv, budgets }] of Object.entries(parsed)) {
    const token = env[tokenEnv];
    if (token === undefined || token === '') {
      throw new Error(`MCP_STATIC_TOKENS: "${principal}".tokenEnv names ${tokenEnv}, which is unset or empty`);
    }
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(`MCP_STATIC_TOKENS: the token in ${tokenEnv} is shorter than ${MIN_TOKEN_LENGTH} characters`);
    }
    if (!B64TOKEN_RE.test(token)) {
      throw new Error(
        `MCP_STATIC_TOKENS: the token in ${tokenEnv} contains characters outside the RFC 6750 token set ` +
          '(letters, digits, . _ ~ + / -, and = only as trailing padding)',
      );
    }

    const allowedBudgets: string[] = [];
    for (const name of budgets) {
      const found = byName.get(name.toLowerCase());
      // A "*" sync id would read as "unrestricted" to every ACL check, so it is
      // refused like an unknown name: a static principal is always restricted, and
      // the unrestricted case is the legacy token.
      if (!found || found.syncId === '*') {
        const available = [...byName.values()].map((b) => `"${b.name}"`).join(', ');
        throw new Error(`MCP_STATIC_TOKENS: "${principal}" references unknown budget "${name}". Available: ${available}`);
      }
      if (!allowedBudgets.includes(found.syncId)) allowedBudgets.push(found.syncId);
    }

    const digest = digestOf(token);
    const other = seen.get(digest.toString('hex'));
    if (other) {
      throw new Error(`MCP_STATIC_TOKENS: the token in ${tokenEnv} is not unique (also used by ${other})`);
    }
    seen.set(digest.toString('hex'), tokenEnv);
    entries.push({ principal, allowedBudgets, digest });
  }

  if (legacyToken) entries.push({ principal: LEGACY_STATIC_PRINCIPAL, digest: digestOf(legacyToken) });
  return entries;
}

type DigestCompare = (a: Buffer, b: Buffer) => boolean;

function matchWith(presented: string, entries: readonly BearerEntry[], compare: DigestCompare): BearerEntry | undefined {
  const digest = digestOf(presented);
  let match: BearerEntry | undefined;
  // Every entry is compared, with no early exit, so timing reveals neither which
  // principal matched nor how many exist. Digests are all 32 bytes, so there is
  // no length short-circuit either (the pre-#572 matcher had one).
  for (const e of entries) {
    if (compare(digest, e.digest) && !match) match = e;
  }
  return match;
}

/** Constant-time lookup of a presented Bearer token. Used for static AND legacy tokens. */
export function matchBearerToken(presented: string, entries: readonly BearerEntry[]): BearerEntry | undefined {
  return matchWith(presented, entries, timingSafeEqual);
}

/**
 * Test seam: the matcher with an injected compare, so a test can count compares.
 * Separate from matchBearerToken so no production caller can pass a compare that
 * is not constant time.
 */
export function _matchBearerTokenWithCompareForTests(
  presented: string,
  entries: readonly BearerEntry[],
  compare: DigestCompare,
): BearerEntry | undefined {
  return matchWith(presented, entries, compare);
}

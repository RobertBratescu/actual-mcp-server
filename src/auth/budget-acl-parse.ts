// src/auth/budget-acl-parse.ts
//
// #551: the pure parser for AUTH_BUDGET_ACL, shared by config.ts (startup
// validation) and budget-acl.ts (runtime classification).
//
// Before #551 a set-but-invalid value was parsed lazily in budget-acl.ts, logged
// once, and replaced by an EMPTY map, which getAllowedBudgets read as "no ACL
// configured": every authenticated principal was granted every budget. A typo in
// the one variable that restricts users to their budgets opened them all. Now a
// set value is validated at startup, and the runtime path denies on failure.
//
// WHY THIS MODULE HAS NO IMPORTS. config.ts validates the raw env value at
// startup by calling parseBudgetAcl. If the parser lived in budget-acl.ts, config
// would import a module that imports config (an ESM cycle leaving one of them
// half-initialised at evaluation time) and would also pull in the chain
// budget-acl.ts -> budget-acl-dynamic.ts -> lib/actual-adapter.ts -> @actual-app/api
// into every config load, stdio included. Keeping this file dependency-free (no
// logger, no config, no zod) is what makes validation at config-parse time
// possible at all. It throws and never logs.
//
// ERROR-TEXT CONTRACT. A thrown message may contain only the variable name, the
// problem class (not JSON, not an object, entry not an array of non-empty
// strings), the zero-based entry index in PARSED key order (JSON.parse puts
// integer-like keys first, so it is not always the order the operator wrote; the
// message says so), and the JSON type found.
// Never a key, a value, JSON.parse's own message (on Node 22 it echoes the input,
// which may hold email addresses), or an Error `cause` carrying any of those. The
// message is printed to stderr at startup and logged at runtime, so it must be
// safe to surface verbatim.

/**
 * Principal to allowed budget sync ids. The object returned by parseBudgetAcl has
 * a NULL prototype: JSON.parse keeps "__proto__" as an own key, and copying such a
 * map into a plain `{}` by assignment would change its prototype instead of
 * storing the entry. Callers must look keys up with Object.hasOwn.
 */
export type BudgetAclMap = Record<string, string[]>;

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Parse the raw `AUTH_BUDGET_ACL` value.
 *
 * Accepts a JSON object whose every value is an array of non-empty strings
 * (`["*"]` is the wildcard). `{}` is valid and means no restrictions; an empty
 * array for a principal is valid and denies that principal. Throws a TypeError
 * under the error-text contract above on anything else, including whitespace-only
 * input, `null`, an array, a scalar, a non-array entry, and an array holding a
 * non-string or an empty string. The caller decides what unset and '' mean.
 */
export function parseBudgetAcl(raw: string): BudgetAclMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError('AUTH_BUDGET_ACL: not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`AUTH_BUDGET_ACL: must be a JSON object (got ${jsonTypeOf(parsed)})`);
  }

  // Null prototype on purpose (see BudgetAclMap). On such an object a plain
  // assignment of the "__proto__" key stores an own property, so no setter can fire.
  const map: BudgetAclMap = Object.create(null);
  // The index follows Object.entries order: integer-like keys (a numeric `sub`)
  // come first and a duplicate key keeps only its last copy, so the message
  // states the order rather than letting the operator count lines in the file.
  const order = '; indexes are zero-based in parsed key order, integer-like keys first';
  let index = 0;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      throw new TypeError(`AUTH_BUDGET_ACL: entry ${index} must be an array of non-empty strings (got ${jsonTypeOf(value)}${order})`);
    }
    for (const id of value) {
      if (typeof id !== 'string') {
        throw new TypeError(`AUTH_BUDGET_ACL: entry ${index} must be an array of non-empty strings (got an array with a ${jsonTypeOf(id)} element${order})`);
      }
      if (id.length === 0) {
        throw new TypeError(`AUTH_BUDGET_ACL: entry ${index} must be an array of non-empty strings (got an array with an empty string${order})`);
      }
    }
    map[key] = [...(value as string[])];
    index++;
  }
  return map;
}

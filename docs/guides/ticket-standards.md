<!-- template-version: 6 -->
<!-- doc-rules-version: 20 -->

# Ticket standards (canonical)

This is the **single source of truth** for what a *ready* work ticket must contain for
actual-mcp-server. The four work issue-templates (`bug`, `feature_request`, `infrastructure`,
`security`) carry the form fields that collect this content; this document holds the **rules and
the rationale**. The `ticket-gate` agent enforces the rules, and
`scripts/check-template-lockstep.sh` keeps the templates and this doc on one shared
`template-version`, so the standard cannot silently drift apart from the forms that implement it.

**This doc carries two markers, and they answer different questions.**
`template-version` says *which form this doc describes*: it is version-locked to the work
templates by `scripts/check-template-lockstep.sh`, and bumping it is what makes `ticket-gate`
re-synthesise every open ticket. `doc-rules-version` says *which revision the rules text below is
at*. A change to the rules that does not change the form fields bumps **only**
`doc-rules-version`, costs nothing downstream, and triggers no synthesis.

## Why single-source

The requirement text used to be restated in each template, in `CLAUDE.md`, and in the gate.
Multiple copies drift: prose says one thing while a template says another, and nobody notices
until a ticket is gated against a stale rule. Keeping the rules here, referenced (not restated)
elsewhere, plus the lockstep guard, makes "the standard is the same everywhere" mechanically
true rather than a matter of discipline.

## The gate that enforces this

`/gate-ticket <N>` runs deterministic mechanical checks, then one critic agent that returns
PASS, NEEDS-WORK or BLOCKED, never a numeric score. Project lenses (tool-author, qa,
release-manager, actual-api, security-auditor, architect-review) join only when a label or the
ticket body touches their domain, and add pass/fail findings to the same review. Reporters are NOT expected to fill the
maintainer-rigor sections (acceptance, scenarios, unit_tests, e2e_tests): the gate synthesises
them from the report, and the fix is proved by reproducing the bug first (red), then re-running
after the fix (green). See the `implement-ticket` skill.

## Required sections

A ready work ticket must satisfy every rule below whose scope the ticket actually touches.
Applicability is decided by the gate from the ticket type and the areas it affects; a rule a
ticket does not touch is marked N/A with a one-line justification, never failed. A rule that
*does* apply and is absent fails the gate.

### 1. GWT scenarios (Given / When / Then)

At least one positive and one negative scenario per independent condition, written against
specific tool names (`actual_{domain}_{action}`), adapter methods, and file paths where the
ticket makes them evident. Vague restatements of the description do not count.

**Scope:** any ticket with an observable behaviour change. The gate derives this from the
ticket type and the areas it affects; the author never self-declares it. N/A is permitted only
where no behaviour delta exists (a pure wireframe, a research spike), and the gate judges that
N/A claim like any other.

**Quality bar** (each point scorable by the gate):

- exactly ONE `When` per scenario; multiple When/Then pairs mean multiple behaviours, split them
- declarative, not click-by-click imperative
- names a real tool, adapter method, or file where the ticket makes one evident
- the negative scenario asserts a SPECIFIC error code or message, never "it fails"
- not a restatement of the summary

### 2. Unit test specs

Concrete cases: a specific test file path under `tests/unit/`, a concrete input value, and the
expected output or error (a ZodError or an error message substring). "Add unit tests" is not a
spec. **When a ticket creates or modifies an MCP tool** (the project's API surface), the tool
must be covered: a happy-path call, negative input rejected by the Zod schema, the smoke entry
in `tests/unit/generated_tools.smoke.test.js`, and, for any published-schema change, the
OpenAI/ECMA-262 compatibility guard (`tests/unit/schema_json_openai_compat.test.js`).
`npm run build && npm run test:unit-js` must be in the acceptance criteria.

### 3. E2E test specs

For any behaviour visible over the transports: a case in `tests/e2e/docker-all-tools.e2e.spec.ts`
(the only E2E file Playwright collects; #366 removed the `tests/e2e/suites/` tree, which never ran),
written against the fixtures in `tests/e2e/fixtures.ts` so it provisions its own data and passes when
run alone (#375). That case carries its setup steps, the action, and the assertion, for both the happy
and unhappy paths. A change to a
tool's write path must be exercised over BOTH transports via the dual-transport gate
(`MCP_TEST_TRANSPORT=http` and `stdio`). Pure-internal changes with no transport-visible surface
mark this N/A with justification rather than inventing a flow.

<!-- adapt-dropped: emulator-clause -->

### 4. Personal data handling

State seven facts, numbered here because the templates, the gate and the `privacy-regime` skill
all count them the same way: (1) every personal-data field the ticket touches (name, email, phone,
GPS, IP); (2) storage location and encryption at rest; (3) erasure, including cascading deletion of
dependent records; (4) portability; (5) minimisation and retention; (6) the legal basis; (7) any
cross-border transfer. A ticket that touches no personal data marks this N/A with that reason.

**This rule names no jurisdiction on purpose.** Those seven facts exist under GDPR, UK GDPR, CCPA
and CPRA, LGPD, PIPEDA and APPI, under different names, different thresholds and different article
numbers. Naming one regime in the default is not merely over-inclusive; for most projects it is the
*wrong* regime, and a gate citing the wrong statute is worse than a gate citing none, because it
looks authoritative. A project that IS under a specific regime installs the privacy-regime lens,
which names its own regime and adds that depth (issue #101).

**Project adaptation.** This server manages personal financial data (accounts, transactions,
payees, balances). Beyond the seven facts, confirm the change preserves per-user budget isolation
(`src/auth/budget-acl.ts`) so one user can never read another's budget. There is no separate GDPR
agent in this project's roster: the `security-auditor` core agent owns data-exposure review.

### 5. Security checklist

Authentication and authorization requirements (OIDC / bearer / budget ACL), input validation
schemas (Zod, via `CommonSchemas` where applicable), data-exposure review, SQL-injection review
when `actual_query_run` is touched (`src/lib/query-validator.ts`), and the relevant OWASP items
for the change. Secrets are never logged (the central `redactSecrets` format is the backstop, not
a licence). Rate limiting is specified or justified as unnecessary.

### 6. Required reviews

The reviews the ticket must pass before it is considered done, checked off explicitly. This is
the ticket author's acknowledgement of the gate, not a substitute for it. A promotion to `main`
additionally requires a green full dual-transport integration run (`bash scripts/deploy-and-test.sh full`).

### 7. Documentation currency

The ticket names the documentation it affects, in the project's documentation tree and its root
README, or states none with a reason. **Scope is deliberately every work ticket**: this is the
one rule where always-asked is the point. It stays passable because "none, no user-visible
surface" is a legitimate answer, and the gate judges that claim like any other N/A, judged
against the ticket's own file list.

### 8. Implementation and dependency concreteness

Judged against whichever fields the template provides (`implementation`, `dependencies`, `files`),
not a new form field: the templates already collect this content, so this rule adds no section and
no `template-version` bump.

- File paths and implementation steps are concrete, and match `docs/coding-standards.md` where the
  project has one.
- Build and test commands the ticket relies on are specified, so an implementer does not guess them.
- Every new dependency is justified against the standard library and the dependencies already
  present.
- Known scalability risks the approach introduces are named, N+1 query patterns first.

A ticket whose template carries none of these fields (for example `infrastructure`) records N/A by
domain, per the N/A rule below.

## Project hard rules every ticket inherits

- Amounts are always integer cents (`5000` = $50.00), never decimal dollars.
- Dates are `YYYY-MM-DD` strings, never `Date.now()`.
- Every Actual API operation is wrapped in `withActualApi()`; new tools use `createTool()`.
- No em dash or en dash anywhere (chat, commits, comments, code, docs). Restructure instead.
- Work lands on `develop`; `main` is release-only.

## Precedence

`ticket-gate` restates parts of this doc so they hold in installs without it. Those restatements
are sanctioned exceptions to the single-source rule above. The forge-kit `scripts/check-restatements.sh` guard
verifies this list in CI where it is installed; this project does not carry it, so the list is
maintained by hand. Each item carries one or more literal ANCHORS into the gate, and the
build fails if an anchor no longer resolves (a stale entry) or if the gate references a rule in a
section no anchor covers (an unlisted restatement). Editing a rule means editing every location its
anchors name, in the same change. An item with no anchor fails too, because an unanchored entry is
exactly the thing that rotted before.

Coverage is per LOCATION, not per section: a rule reference must sit within two lines of an anchor
that covers it. Per-section coverage was tried first and was shown to be worthless here, because
once a big section like Step 3B was anchored for a rule anywhere, a brand-new bar for that rule
elsewhere in the same section inherited the licence and passed.

**What the guard does NOT prove, stated plainly, because overclaiming is this section's own bug.**
Detection keys on the literal token `rule N` (or `rules N and M`), validated against the rule
numbers this doc defines. A restatement that paraphrases a rule without naming it is invisible, and
two listed entries are in that shape today: the security lens checklist, whose file contains no
rule token at all, and rule 8's implementation concreteness in the critic's brief. So this list is
complete with respect to everything the guard can see, which is a narrower claim than the one this
section used to make and get wrong three review rounds running.

Coverage used to be per ITEM rather than per anchor, so a new bar for one rule an item names could
sit beside an anchor for another rule it names and pass. **#138 closed that**: an item naming more
than one rule must scope each anchor (`:: rules N`), and an unscoped one is refused rather than
silently generous. An anchor must also be on ONE line, because matching only its first line was a
prefix match wearing an exact match's clothes, and an item that cites no rule number at all is
refused, because it covers nothing while looking like it covers something.

**Therefore: a restatement added to the gate MUST name its rule.** Writing `(rule 7)` beside the
bar is what makes the next one detectable. A paraphrase citing no rule number is the one shape that
can still fork silently, so do not create more of them.

1. The three hard-fail bars: UI E2E (rule 3), API endpoint coverage (rule 2), and the
   personal-data judgment (rule 4), in the critic's brief.
   <!-- anchor: "**UI E2E (rule 3):**" :: rules 3 -->
   <!-- anchor: "**API endpoint coverage (rule 2):**" :: rules 2 -->
   <!-- anchor: "**Personal-data judgment (rule 4):**" :: rules 4 -->
2. The security lens checklist, which restates rule 5 point for point. It lives in the
   `ticket-gate-reference` skill since #109, not in the agent file.
   <!-- anchor: "OWASP Top 10: injection, XSS, CSRF" -->
3. Rule 1's GWT quality bar, which appears four times: in the Step 0c-iii synthesis table, and
   three times in `check-ticket-mechanics`, which took Step 3A's checks over from prose in
   #149, the third being the N/A clause check 4 refers since #241.
   <!-- anchor: "Apply the rule-1 quality bar" -->
   <!-- anchor: "check 4: GWT structure (rule 1, the checkable half)" -->
   <!-- anchor: "narrower than rule 1's quality" -->
   <!-- anchor: "the critic must judge rule 1 unaided" -->
   <!-- anchor: "legitimate only where rule 1 finds no behaviour delta" -->
4. Rule 2's integration and regression coverage, and rule 8's implementation concreteness (build
   and test commands, dependency justification, N+1 and scalability), which the critic's brief
   carries as blocking-capable concerns. These joined this doc in #117 (issue #94); before that
   they existed only in the gate, so the list did not need them.
   <!-- anchor: "test-case quality and edge cases, including integration and regression coverage" :: rules 2 -->
   <!-- anchor: "file paths and implementation concreteness" :: rules 8 -->
5. Rule 3's emulator clause, which the critic's brief restates near-verbatim. Item 1 covers rule
   3's UI E2E hard-fail bar, which is a different clause of the same rule.
   <!-- anchor: "rule 3's emulator clause" -->
6. The Step 0c-iii synthesis table, whose rows restate the SHAPE required by rules 2, 3, 4 and 7,
   because the synthesis sub-agent has to be told what to write. Item 3 covers rule 1's appearance
   in that same table; these are the other four.
   <!-- anchor: "| Section | Derived from |" :: rules 2, 3, 4 and 7 -->
7. The unit-test check in `check-ticket-mechanics`, which restates rule 2's concrete-spec bar
   as a mechanical check, down to rejecting a bare "add unit tests", and restates the N/A rule's
   own rationale. It was Step 3A prose until #149.
   <!-- anchor: "legitimate only where rule 2 is out of scope" -->
   <!-- anchor: "the critic must judge rule 2 unaided" -->
8. Rule 7 in four further places: twice in `check-ticket-mechanics` (check 6's bar and the
   reason it refers rather than passes), the critic's brief, and the Rules section (its
   every-work-ticket scope).
   <!-- anchor: "HOLDS is rule 7, judged by the critic" -->
   <!-- anchor: "rule 7 applies to every work ticket:" -->
   <!-- anchor: "documentation currency (rule 7) judged against the ticket's own file list" -->
   <!-- anchor: "documentation currency (rule 7) applies to every work ticket" -->
9. Rule 1's SCOPE clause at Step 3B. Item 3 covers rule 1's quality bar, which is a different
   clause.
   <!-- anchor: "an N/A claim is legitimate only where no behaviour delta exists" -->
10. Rule 3's UI E2E hard-fail bar AGAIN, twice in `check-ticket-mechanics`. Item 1 covers the
   same bar in the critic's brief; this is the mechanical half, and no review round ever named it.
   The guard found it on its first run, and #149 moved it from prose into the script.
   <!-- anchor: "UI at all (rule 3), is Step 3B's call" -->
   <!-- anchor: "rule 3 says a UI-touching ticket cannot claim it" -->
   <!-- anchor: "the critic must judge rule 3 unaided" -->

<!-- restatement-allow: Step 2.5 :: rule 4 :: routing row for the optional
     privacy-regime skill; it states no bar of its own and only notes that rule 4 still binds when
     the skill is absent -->


Editing rule 5 or rule 1 therefore means editing the gate in the same change. The list used to
claim the hard-fail bars were the *only* exception, which was false, so a maintainer editing rule 5
got no signal in the exact place this doc certified as drift-free.

Where this doc IS installed, its text governs, and three cases are distinguished:

- **Conflict.** The gate's copy and this doc state different things: **this doc wins.** The gate's
  copy is a convenience restatement, never a fork.
- **Absence.** A rule is missing from an installed (possibly adapted-down) copy of this doc: that
  is NOT divergence. Absence never relaxes a gate bar; only explicit text here does.
- **A stricter restatement.** The gate says the same thing at finer granularity than this doc (its
  three enumerated auth cases against a doc that once said only "auth 401/403"). This is neither
  conflict nor absence, and the extra strictness is **ADVISORY, never blocking**. The gate reports
  it as a gap in this doc, naming the rule, so the fix is to tighten the doc and make the bar
  legitimately blocking. A stricter gate copy must never out-rule the canonical doc silently, or
  the single-source claim is fiction.

## The N/A rule (load-bearing)

A coverage or E2E requirement that a docs-only, research, infra-only, or internal-only ticket
cannot satisfy makes that ticket **un-passable**, which trains people to box-tick and rots the
whole gate. Every rule here is scoped: it applies only to tickets whose type and affected areas
bring it into play, and the gate derives that scope rather than asking the author to self-declare
it. When you add a new rule with a coverage-style requirement, give it an explicit
type-and-area scope here, or it will backfire.

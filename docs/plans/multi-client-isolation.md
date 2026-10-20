# Plan: Multi-client isolation

## Goal

Let several MCP clients share one HTTP server without seeing or reaching each other's budgets. This is the reimplementation on `develop` of PR #569 by @jospaquim, split into its three independent parts: close the listing and import gaps in the budget ACL (#570), make every session talk to its own budget's Actual server (#571), then add per-principal static tokens with a budget allow-list (#572), which builds on both.

## Done looks like

- #570: a restricted principal sees only its permitted budgets from `actual_budgets_list_available` and `actual_budgets_get_all`, and `actual_budgets_import` is refused with a `Budget ACL:` error and an `acl_denied` log. Wildcard, `MCP_SSE_AUTHORIZATION`, auth-disabled and stdio callers see no change. The import outcome before the fix is recorded on the ticket.
- #571: both paths reproduced against two local Actual servers (or recharacterised), then a new session connects to its starting budget's server and re-selection re-initialises on a server change. A single-server setup makes no extra login per operation.
- #572: the A or B storage decision is recorded on the ticket before code; two static principals with different allow-lists cannot list, switch to, read or write each other's budgets, and a fresh session never restores the other's preference. `MCP_STATIC_TOKENS` with `AUTH_PROVIDER=oidc` refuses startup.
- @jospaquim is co-author on every commit that uses their code and credited in the release notes.
- Each ticket is one commit with a patch bump on `develop`. #570 is released on its own as soon as it lands (security fix). The phase ends with `bash scripts/deploy-and-test.sh full` green over HTTP and stdio with zero residue, then a release to `main`.

## Fails if

Premortem: the phase is over and it failed badly. What happened?

- #570's filters keyed on the wrong field (the registry entry's `syncId` against the upstream file's `id` instead of `groupId`), so a restricted caller saw an empty list and the tests, built from fixtures we chose ourselves, passed anyway.
- `getBudgetRegistry()` was filtered at startup too, outside any request, so registry validation saw a partial registry and a valid configuration was refused.
- #571's re-selection called a pool method that takes the api lock from inside `withApiLock`: every cross-server operation stalled 30 seconds and timed out.
- #571 compared `serverUrl` loosely (trailing slash, case), so a single-server setup re-initialised on every operation and the #127 login burst came back.
- One server's password or encryption password was sent to the other server, or written to a log.
- #572 was ported from the PR with its source-regex guards instead of behavioural tests, so removing the `allowedBudgets` assignment kept every test green.
- A token value appeared in a startup refusal or a log line, or a short or duplicate token was accepted.
- `MCP_STATIC_TOKENS` set under OIDC was silently ignored, so an operator believed clients were isolated when they were not.
- The release notes did not tell OIDC users with restricted ACLs that their listings now shrink and import is refused.

## Expected work

Not binding. In order:

1. #570, released alone.
2. #571 (needs a second Actual server container for the reproduction).
3. #572, gated after the other two close, with the manual two-token run recorded on the ticket.
4. Full dual-transport run, then release.

## Out of scope

- #413 (one api instance per budget): Backlog, design on request only. This phase keeps the process-global singleton and its lock.
- Dynamic ACL (`AUTH_BUDGET_ACL_SOURCE=actual`) for static principals, unless #572 picks option B.
- Removing a deleted principal's #189 preference entry from the store.
- #557, #562: icebox. #479, #548: blocked upstream.
- New lows from reviews of this phase go to Backlog unless they are a defect in this phase's own fix.

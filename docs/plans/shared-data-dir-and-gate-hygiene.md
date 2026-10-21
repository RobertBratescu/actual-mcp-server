# Plan: Shared data dir and gate hygiene

## Goal

Make the dual-transport release gate trustworthy again: it must stop being the second writer on the data dir it is testing (#575) and stop leaving residue on the test budget (#576). Ship the two direct dependency bumps from PR #554 (#579, #580) through the same full run, since they need it anyway and carry no design risk. Every later phase, starting with Actual API 26.11 adoption, releases through this gate.

## Done looks like

- #575: paths 1 (trailing sync after pooled writes) and 2 (#390 precondition sync before a re-selection) are each reproduced or recorded on the ticket as not reproducing, with the measurement. The (a) lock versus (b) separate data dir choice is recorded on the ticket with its reason before code. `deploy-and-test.sh full` no longer runs a second process on the server's data dir, and DEPLOYMENT.md states one process per data dir.
- #576: a full run leaves no `REG270-*` object on the test budget, also when the stalled op hung; the existing leftovers are removed once, on the disposable budget only.
- #579: dotenv, zod and @types/node at the latest patch, the lockfile diff limited to those three plus the root version, zod provenance verified, `dotenv_stdout_quiet` witnesses U2 and U3a still seeing output.
- #580: @playwright/test 1.64.1 with all three image sites moved, `playwright-version-drift` green, `test:e2e:docker:full` green.
- Each ticket is one commit with a patch bump on `develop`. The phase ends with two consecutive `bash scripts/deploy-and-test.sh full` runs green over HTTP and stdio with zero residue (the second run proves the first left nothing broken behind), then a release to `main`.

## Fails if

Premortem: the phase is over and it failed badly. What happened?

- #575 moved the #270 stdio step to its own data dir, the gate went green, and paths 1 and 2 were never reproduced. The stale-copy class was hidden from the gate, not removed, and the next shared mount (the local-env OIDC and bearer instances already share one) hit it in front of a user.
- #575 chose a lock file and a crashed server or a container restart left it behind, so the next start refused and a self-hosting user was locked out of their own budget. Or the lock was keyed on a path the two local-env instances spell differently, so it never fired.
- The fix "repaired" a stale copy by deleting a budget's local copy automatically, which the ticket forbids, and took unsynced local changes with it.
- #576's sweep pattern matched a name that was not ours (`REG270 budget`, no pid suffix), or the one-off cleanup ran against a real budget instead of `_test-budget`.
- #576's cleanup ran in a finally path that itself hung behind the stalled op, so the regression step now times out instead of leaking, and the gate went red for a reason unrelated to the change under test.
- The gate was declared trustworthy on a single green run. The broken local copy from #575 shows up on the NEXT run's session open, so one run cannot prove it gone.
- #579's zod bump changed ZodError wording or the published `tools/list` schema, and an expectation was updated to match without naming it as a contract change, so a client broke after release.
- Either bump refreshed a transitive package in the lockfile, against the direct-only policy, and that package carried the regression.

## Expected work

Not binding. In order:

1. #576 first: small, and a clean budget makes every later run's listing honest.
2. #575: reproduce paths 1 and 2, record the (a) or (b) decision, implement.
3. #579 and #580, one commit each; one release bump may cover both if they land in the same train.
4. Two consecutive full dual-transport runs, then release.

## Out of scope

- #413 (one api instance per budget): Backlog, design on request only.
- #577 and #581 (per-principal session cap and its admission race): Backlog.
- #479, #548 and the @actual-app/api 26.11.0 bump: the next phase, Actual API 26.11 adoption.
- Any transitive dependency refresh, including the hono advisory closed under #578.
- New lows from reviews of this phase go to Backlog unless they are a defect in this phase's own fix.

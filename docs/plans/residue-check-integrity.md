# Plan: Residue check integrity

## Goal

Make the zero-residue assertion in the dual-transport release gate mean what it says. Today it can certify a budget it never read (#583: a failed listing is counted as empty) and it never sees category groups (#584: the `{ groups: [...] }` shape is dropped). Every later phase, including Actual API 26.11 adoption, releases through this gate, so its "residue: 0" has to be true first.

## Done looks like

- #584: `findResidue` reads `{ groups: [...] }`, a test-named group is counted and swept, a human-named group is not. The unit row for the leak is red on the old code and green on the new.
- #583: an unreadable listing (error text, a non-listing shape, a thrown call) is reported as "could not check" and fails the runner's post-run assertion with its own nonzero exit, distinct from residue. A readable empty budget still passes. The sweep stays best effort.
- `scripts/assert-no-residue.mjs` either uses the shared check or says in a comment why it keeps its own probe.
- One commit per ticket on `develop`, one patch bump for the release. The phase ends with one green `bash scripts/deploy-and-test.sh full` over HTTP and stdio, zero residue now including groups, then a release to `main`.

## Fails if

Premortem: the phase is over and it failed badly. What happened?

- #584 made groups visible and the first full run went red on groups leaked by earlier runs. Someone "fixed" it by loosening the pattern instead of letting the pre-run sweep remove them, and the check is blind again.
- The sweep, now seeing groups, deleted a group that was not ours, because the test-name pattern matched a human name. Or it deleted a group before its categories and the delete failed or moved categories.
- #583 turned a transient rate-limited login into a red gate on every other run, so "could not check" was quietly downgraded back to "clean" to get a release out.
- The unreadable-versus-empty decision was made by matching message text, so a new error wording reads as clean again.
- The new unit rows could not fail: they passed on the old code too, and nobody ran them against it.

## Expected work

Not binding. In order:

1. #584 first: it is a one-line shape fix with a red row, and it makes #583's negative cases cover groups as well.
2. #583: a distinct unreadable outcome from `findResidue`, mapped to a nonzero exit in the runner and in `scripts/assert-no-residue.mjs`.
3. One full dual-transport run, then release.

## Out of scope

- Session admission hardening (#581, #577): the next phase.
- @actual-app/api 26.11.0 and #479, #548: Actual API 26.11 adoption.
- Any change to what the integration modules create, or to their own cleanup.

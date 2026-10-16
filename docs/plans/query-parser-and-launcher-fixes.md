# Plan: Query parser and launcher fixes

## Goal

Fix the three P2 bugs found while implementing the Reporter follow-ups phase: `actual_query_run` matches a value with an escaped apostrophe (#567), accepts `NOT LIKE` on a joined field (#566), and `npm run dev` / `npm run test:mcp-client` start the server again (#565). Release once, with dual-transport evidence, at the end.

## Done looks like

- #567: `=`, `!=`, the ordering operators, `LIKE` and `NOT LIKE` decode `''` to `'`, so `payee.name = 'O''Brien'` returns that payee's transactions; `IN` keeps the doubling (#421, #433). Integrated through `/merge-pr 568`, crediting the contributor as co-author, with an E2E case over both transports.
- #566: `payee.name`, `category.name` and `account.name` with `NOT LIKE` (and `NOT IN`, `NOT BETWEEN` if the same scan misreads them) validate, while a real unknown field is still rejected by name.
- #565: `npm run dev -- --http` reaches "MCP Streamable HTTP Server listening", and `npm run test:mcp-client` gets past initialize or its live-server requirement is documented. A unit test pins the launcher path and the bare `--` handling, with an unknown flag still rejected.
- Each ticket is one commit with a patch bump on `develop`. The phase ends with `bash scripts/deploy-and-test.sh full` green over HTTP and stdio with zero residue, then a release to `main`.

## Fails if

Premortem: the phase is over and it failed badly. What happened?

- #567's decoding also ran on the `IN` path, so the #433 escape was undone and an inlined `$oneof` value could close its quote: an injection regression. The `IN` case and the #421/#433 tests are the guard.
- #567 was taken from PR #568 without checking the contributor's E2E: they could not pull the Playwright runner image, so it was never run on the docker stack. Our full run must execute it.
- #566 was fixed by skipping every uppercase word in the field scan, so a real unknown field written in capitals slipped through the read-only shape gate (#162).
- #565 accepted a bare `--` by loosening the strict flag check, so a typo flag started the server silently.
- #565's 401 was "fixed" by disabling auth in the client harness instead of sending the configured token.
- The README or AGENTS.md still described the old broken commands, or a fix changed user-visible query behaviour that the README does not mention.

## Expected work

Not binding. In order:

1. #567 via `/merge-pr 568`.
2. #566 (same parser area, so right after).
3. #565.
4. Full dual-transport run, then release.

## Out of scope

- #557 and #562: icebox.
- #413, #479, #548: Backlog (design on request only; blocked upstream).
- New lows from reviews of this phase go to Backlog unless they are a defect in this phase's own fix.

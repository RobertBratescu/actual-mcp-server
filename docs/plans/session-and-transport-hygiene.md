# Plan: Session and transport hygiene

## Goal

Close the four gate-ready lows about HTTP session bookkeeping, transport error logging and refresh-token guidance that the v0.22.18 and v0.22.19 reviews filed, so that no transport outlives its pool entry, no error burst is silently dropped from the log, session ownership is proven at the Express layer, and the OIDC docs tell an operator how to bound a refresh token.

## Done looks like

- #529: an Express-level test runs `startHttpServer` on an ephemeral port with a stubbed OIDC verifier and two principals, and proves that a non-owner gets the same JSON-RPC `-32001` as an unknown session on `tools/call` and a byte-identical `tools/list` refusal, that the owner's `lastActivity` does not move, and that the owner still gets `200`. The test was mutation-checked: removing the ownership check turns it red.
- #530: a transport whose pool entry was dropped and never re-created is evicted by the idle sweep, together with its owner record, in one step. A unit test with a transport and an owner but no pool entry advances the sweep clock and asserts removal; the negative case (entry re-created) is kept.
- #536: `createWindowLimiter` reports the suppressed count even when the burst is the last error in the window, through an unref'd timer or a window-rollover summary, and `tests/unit/transport_onerror.test.js` covers the last-burst case.
- #488: `docs/SECURITY_AND_PRIVACY.md`, `docs/guides/AI_CLIENT_SETUP.md` and the README env table carry IdP-neutral refresh-token hardening guidance (RFC 9728, RFC 9700), and `npm run config-drift` stays green.
- Each ticket's change is on `develop` with a patch bump, and the set is released with dual-transport evidence.

## Fails if

Premortem: the phase is over and it failed badly. What happened?

- #529's Express-level test passed against a server that never enforced ownership, because the stubbed verifier returned the same principal for both tokens, or because the test only compared status codes and not the JSON-RPC body. The byte-identical `tools/list` comparison and the `lastActivity` assertion were skipped as "too fiddly". Mutation-check it: disable the ownership check and the test must go red on every scenario.
- #530's eviction removed the transport but left the owner record, or the reverse, so a stale owner blocked a new session with the same id, or an orphaned transport kept the leak. Owner and transport removal must be one atomic step, and the test must assert both.
- #530's sweep evicted a transport whose pool entry was in the middle of being re-created (the per-session budget load, #390 and #406), so a live session saw "Transport not ready" mid-request. The negative case (entry re-created) must include the in-flight load, not only the settled one.
- #536's timer kept the process alive under stdio, because it was not unref'd, so `--stdio` sessions stopped exiting when the client closed the pipe. The stdio E2E leg (#423) is the check.
- #488 recommended a specific IdP's setting as if it were general, repeating the #317 mistake where the documentation actively recommended a broken setting. Keep it IdP-neutral and cite the RFCs, not a vendor page.
- The phase grew: review rounds on these fixes filed new lows and those were pulled in here. New lows go to Backlog unless they are a defect in this phase's own fix.
- The three code tickets were done in one commit, so a defect in one could not be reverted alone. One ticket, one commit, one patch bump.

## Expected work

Not binding. In order:

1. #529: session ownership proven at the Express layer (test only; optionally move the GET ownership check ahead of `transports.has`).
2. #530: evict a transport whose pool entry was dropped and never re-created.
3. #536: window limiter reports the suppressed count for a last burst.
4. #488: refresh-token hardening guidance (docs only).

## Out of scope

- #413 (one api instance per budget): Backlog, design work requested on its own.
- #479 and #548: Backlog, blocked upstream.
- New review findings at low severity raised while doing this phase's work: Backlog.

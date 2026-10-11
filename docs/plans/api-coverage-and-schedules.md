# Plan: API coverage and schedules

## Goal

Every schedule shape the Actual UI can create can also be created through the MCP server, and every `@actual-app/api` method the drift lane reports has a decision: a tool, or an accepted gap with its reason.

## Done looks like

- `actual_schedules_create` and `actual_schedules_update` accept monthly `patterns` (days of the month, the last day, the nth or last weekday), refuse them on any other frequency or with an out-of-range value, and a patterned schedule created through the server reads back with the `next_date` the Actual UI shows (#478).
- `amountOp: 'isbetween'` either stores a real `{ num1, num2 }` range that reads back the same, or is refused with a typed error naming the alternative. Which one is decided by a live measurement of what Actual does with the scalar form, recorded on #527.
- `mergeTransactions` is exposed as `actual_transactions_merge`, annotated destructive, with its refusals (different amounts, transfers to different accounts, not two distinct ids) passed through as actionable messages, and E2E coverage in `tests/e2e/docker-all-tools.e2e.spec.ts` (#514).
- `setPreference` is an accepted gap in `docs/audit/api-coverage-baseline.json`, with its reason and #515 (#515).
- The api-surface-drift lane reports no unaccepted, unticketed method at the installed `@actual-app/api`.
- A full dual-transport run (`bash scripts/deploy-and-test.sh full`) is green with zero residue after the last change in the phase.

## Fails if

Premortem: it is the end of this phase and it failed badly. What happened?

- **Patterned schedules were accepted but stored wrong.** The schema let `patterns` through, Actual saved them in a shape its own UI does not read, and a user's "rent on the last day" schedule silently fell on the wrong day. Guard: the acceptance for #478 is a read-back of `next_date` against a live budget for each of the three pattern kinds, not a schema test alone.
- **An update erased patterns the user set in the UI.** `actual_schedules_update` rewrote `date` without the existing `patterns`, and a working schedule lost its recurrence. Guard: a test that updates an unrelated field on a patterned schedule and reads the patterns back unchanged.
- **The merge tool deleted the wrong transaction.** An assistant merged two transactions it believed were duplicates, upstream kept the one the user did not expect, and the other (with its notes or split) was gone. Guard: the tool description says which one upstream keeps and that the other is deleted, the result names the kept id, and a split case is covered by a test.
- **The `isbetween` fix guessed.** The range form was added from the ticket's description of Actual's model without checking it, and every range schedule matches nothing. Guard: measure first; the range form ships only if a range schedule created through the server matches a transaction in the range on a live budget.
- **The phase grew.** The drift lane reported another method mid-phase, or schedule date expansion (#479) looked close, and the phase stretched to absorb it. Guard: a new method is a new ticket in Backlog; #479 stays blocked on actualbudget/actual#9020.

## Expected work

- #515: accept `setPreference` in the coverage baseline with its reason. First, because it is the smallest and proves the baseline path.
- #527: measure the scalar `isbetween` form live, then support the range or refuse it.
- #478: monthly `patterns` in `RecurConfigSchema`, with the update-preserves-patterns case. After #527, since both touch the schedule tool schemas.
- #514: the new `actual_transactions_merge` tool, through the full new-tool checklist (tool count 83 to 84).

Not binding: if the #527 measurement shows the scalar form is meaningful, the ticket may close with a refusal and no range support.

## Out of scope

- Expanding schedule dates (#479): blocked upstream on actualbudget/actual#9020. Backlog.
- A preferences write tool of any kind: `setPreference` is accepted as a gap, not narrowed into an allowlisted tool. Backlog, if a user asks.
- Replacing `addFrequency` in `src/lib/financial-analysis.ts`: part of #479. Backlog.
- The session and transport tickets (#529, #530, #536, #488): their own phase, Session and transport hygiene.

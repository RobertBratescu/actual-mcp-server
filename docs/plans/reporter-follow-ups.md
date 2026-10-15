# Plan: Reporter follow-ups

## Goal

Ship the fixes split out of three outside reports, in three batches, each released with dual-transport evidence before the next starts: tool content no longer reaches the server logs (#555), an HTTP client can end its session and every session end frees its budget state (#552), and chat models get accurate server instructions plus a hint when they guess a name that does not exist (#553).

## Done looks like

- Batch 1, logs: #556 no tool argument or result is logged at any level by `callTool`, `createTool` or the HTTP transport, proven by a unit test that captures every log stream at `debug` and searches it for a sentinel value from the arguments and the result, on success and on failure. #558 `.env.example` no longer pins `MCP_BRIDGE_LOG_LEVEL=debug`. #559 the known throw sites that quote input (`categories_create`, `query_run`, plus any found by a bounded search) no longer reach the `[TOOL ERROR]` log line with the input in it, while the client still receives the full message.
- Batch 2, sessions: #564 every teardown path clears the per-session budget state, proven by a test that ends a session through the idle sweep and asserts the entry is gone. #563 `DELETE` on the MCP path ends the session in every pool state, the client gets a spec response (not an HTML 404), and an E2E case covers it over HTTP.
- Batch 3, instructions: #560 one instructions source built from the published tools, sent only through the spec `instructions` field on both transports, with the false "proxy any API call" sentence gone. #561 an empty `actual_query_run` result whose name condition matches no entity carries a `hint`; a real entity with no rows still returns a plain empty result.
- Each ticket is one commit with a patch bump on `develop`; each batch is released to `main` after `bash scripts/deploy-and-test.sh full` is green over HTTP and stdio with zero residue.

## Fails if

Premortem: the phase is over and it failed badly. What happened?

- #556's test searched only the message string, while the content still went out under a structured `args` or `result` meta field, so the test passed and the leak stayed. The sentinel search must cover the whole serialized log record, at `debug`, over both a success and a failure.
- #556 removed the content and with it every useful field (tool name, duration, outcome), so the next real bug report had nothing to work with. The log lines stay; only the content goes.
- #559 turned into an open-ended audit of 84 tools and upstream messages, holding batch 1 open. It is bounded to the known sites plus one search; anything more is re-ticketed.
- #559 shortened the message the CLIENT sees, so models lost the text they need to recover. The client message is unchanged; only the log copy changes.
- #564 cleared the budget state on teardown while a load for that session was still in flight (#390, #406), and the load re-created the entry afterwards. The test must cover a teardown during an in-flight load, or the fix must make a late load harmless.
- #563 handled `DELETE` but left a transport behind when the pool entry was already gone (the #530 state) or when the pool is disabled, the two states the ticket names. Each state needs its own case.
- #563 let one principal end another principal's session. `DELETE` goes through the same ownership check as `POST` and `GET`.
- #560's instructions named a tool hidden by `MCP_TOOLSETS` or `MCP_READ_ONLY`. They are built from the published set, and a test runs them under the `chat` preset and read-only.
- #561 added the hint to every empty result, so a real category with no transactions looked like a wrong name. The negative case is mandatory.
- A release went out with HTTP-only evidence. The dual-transport report must match the develop HEAD sha.

## Expected work

Not binding. In order:

1. Batch 1: #556, #558, #559 (bounded), then release.
2. Batch 2: #564, then #563, then release.
3. Batch 3: #560, then #561, then release.

## Out of scope

- #557 (opt-in content logging) and #562 (instructions override): icebox until the evidence each names exists.
- #413, #479, #548: Backlog (design on request only; blocked upstream).
- New lows from reviews of this phase's work go to Backlog unless they are a defect in this phase's own fix.

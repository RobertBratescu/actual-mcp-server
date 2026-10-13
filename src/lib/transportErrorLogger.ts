/**
 * Transport-level error logging (#504).
 *
 * `@modelcontextprotocol/sdk` reports transport and protocol errors through
 * `transport.onerror`, which `Protocol.connect` chains into the Server's `onerror`.
 * Nothing set it, so refusals (batch cap, parse errors, unknown ids) were invisible.
 *
 * The error text can echo CLIENT content (payloads, headers), so it is sanitized before
 * it is logged, the log message is a CONSTANT (the logger runs winston splat(), which
 * interpolates `%o`/`%s` in the message), and the Error object, stack and cause are never
 * passed to the logger (format.errors({ stack: true }) would re-emit the raw message).
 * Volume is bounded by ONE per-process window limiter.
 */

import { createModuleLogger, type ModuleLogger } from './loggerFactory.js';
import { requestContext } from './requestContext.js';

const MAX_DETAIL_CODE_POINTS = 200;
const CUT_CHARS = /[{["'`]/;
// Control (C0, C1), line/paragraph separators, bidi format characters, and (#535) the
// invisible marks that can hide or reorder text in a log line: the Arabic letter mark,
// zero-width space/joiners, LRM/RLM and the BOM. Written with escapes, as src/logger.ts
// does: a raw U+2028 in source would terminate the literal.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const OMITTED = '[payload omitted]';

/** Pure: turn an arbitrary thrown value into a bounded, payload-free, single-line string. */
export function sanitizeTransportErrorDetail(value: unknown): string {
  let raw = '';
  try {
    if (value === null || value === undefined) raw = '';
    else if (value instanceof Error) raw = String(value.message);
    else raw = String(value);
  } catch {
    raw = '';
  }
  let cut = false;
  const cutAt = raw.search(CUT_CHARS);
  if (cutAt >= 0) {
    raw = raw.slice(0, cutAt);
    cut = true;
  }
  let s = raw.replace(/%/g, ' ').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, MAX_DETAIL_CODE_POINTS).join('');
  if (cut) s = s ? `${s} ${OMITTED}` : OMITTED;
  return s === '' ? '[no message]' : s;
}

export interface WindowLimiter {
  take(): { allowed: boolean; suppressed: number };
}

export interface WindowLimiterOptions {
  max: number;
  windowMs: number;
  now: () => number;
  /**
   * #536: called once with the suppressed count when a window that suppressed calls
   * ends without a later allowed call to report it. Absent: no timer is ever created
   * (the pre-#536 behaviour, which the tests' bare limiters rely on).
   */
  onWindowEnd?: (suppressed: number) => void;
  /** Timer seam for tests. The default `unref()`s so the flush never holds the process open. */
  schedule?: (fn: () => void, delayMs: number) => void;
}

function defaultSchedule(fn: () => void, delayMs: number): void {
  setTimeout(fn, delayMs).unref();
}

/**
 * Fixed-window limiter: first `max` calls per window pass, the rest are counted.
 *
 * The count is reported by whichever comes first: the next allowed call (it carries
 * `suppressed` on its own record) or, when `onWindowEnd` is set, a flush scheduled on
 * the FIRST suppressed call of the window for the window's end (#536: before that a
 * burst that was the last error ever lost its count). Each path zeroes the count, so
 * the other finds 0 and reports nothing: never twice. A late flush (busy event loop)
 * reports whatever accumulated by then, and the next suppression after a flush
 * schedules a fresh one, so while the process runs a count is delayed at worst. The
 * default timer is unref'd by design (it must not hold a stdio process open), so a
 * shutdown inside the window drops the pending count.
 */
export function createWindowLimiter(opts: WindowLimiterOptions): WindowLimiter {
  let windowStart = 0;
  let count = 0;
  let suppressed = 0;
  let started = false;
  let flushPending = false;
  const schedule = opts.schedule ?? defaultSchedule;
  const flush = (): void => {
    flushPending = false;
    if (suppressed <= 0) return;
    const reported = suppressed;
    suppressed = 0;
    try {
      opts.onWindowEnd?.(reported);
    } catch {
      // a throwing reporter must not escape the timer callback
    }
  };
  return {
    take() {
      const t = opts.now();
      if (!started || t - windowStart >= opts.windowMs) {
        started = true;
        windowStart = t;
        count = 0;
      }
      if (count < opts.max) {
        count++;
        const reported = suppressed;
        suppressed = 0;
        return { allowed: true, suppressed: reported };
      }
      suppressed++;
      if (opts.onWindowEnd && !flushPending) {
        flushPending = true;
        try {
          // Clamp to [0, windowMs]: a backward clock step would otherwise grow the
          // delay past the window (and past Node's 2^31 ms timer limit, which fires
          // after 1 ms and turns the summary into one line per error).
          schedule(flush, Math.min(opts.windowMs, Math.max(0, windowStart + opts.windowMs - t)));
        } catch {
          flushPending = false; // a failed schedule must not escape take(); the next suppression retries
        }
      }
      return { allowed: false, suppressed: 0 };
    },
  };
}

let summaryLog: ModuleLogger | undefined;

/**
 * #536: the window-end summary. One constant message, one number, never stdout.
 * Logged inside `requestContext.exit`: the flush timer inherits the AsyncLocalStorage
 * store of the request that first hit the limit (ALS propagates through setTimeout),
 * and `addCorrelation` in src/logger.ts would stamp that one session's ids on an
 * aggregate that counts errors from every session. Never throws.
 */
export function reportSuppressedTransportErrors(suppressed: number, logger?: ModuleLogger): void {
  try {
    const log = logger ?? (summaryLog = summaryLog ?? createModuleLogger('TRANSPORT'));
    requestContext.exit(() => {
      log.warn('MCP transport errors suppressed', { suppressed });
    });
  } catch {
    // never throw into a timer callback
  }
}

// ONE limiter per process so many HTTP sessions cannot multiply the budget.
const moduleLimiter = createWindowLimiter({
  max: 50,
  windowMs: 60_000,
  now: Date.now,
  onWindowEnd: (n) => reportSuppressedTransportErrors(n),
});

function safeErrorName(error: unknown): string {
  try {
    const name = (error as { name?: unknown } | null | undefined)?.name;
    return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error';
  } catch {
    return 'Error';
  }
}

interface ErrorHookTarget {
  onerror?: ((error: Error) => void) | undefined;
}

/**
 * Install a server.onerror that logs a sanitized, rate-limited record. Chains any prior
 * handler. The handler never throws (stdio invokes it inside a stdin data handler).
 */
export function attachTransportErrorLogger(
  server: ErrorHookTarget,
  transport: 'http' | 'stdio',
  deps: { logger?: ModuleLogger; limiter?: WindowLimiter } = {}
): void {
  const prev = server.onerror;
  const limiter = deps.limiter ?? moduleLimiter;
  let log: ModuleLogger | undefined = deps.logger;
  server.onerror = (error: Error) => {
    try {
      if (typeof prev === 'function') prev(error);
    } catch {
      // a broken prior handler must not stop ours or escape into the SDK
    }
    try {
      const { allowed, suppressed } = limiter.take();
      if (!allowed) return;
      log = log ?? createModuleLogger('TRANSPORT');
      log.warn('MCP transport error', {
        transport,
        errorName: safeErrorName(error),
        detail: sanitizeTransportErrorDetail(error),
        ...(suppressed > 0 ? { suppressed } : {}),
      });
    } catch {
      // never throw into the SDK
    }
  };
}

import api from '@actual-app/api';
import { withOpTimeout } from './opTimeout.js';
import { setApiLogin, setLoadedBudgetSyncId, registerBudgetLoad, loginsSpanServers, type ApiLogin } from './apiState.js';

/**
 * #571: the ONLY place in src/ that calls `api.init`.
 *
 * With a multi-server budget registry, whether the singleton may skip a login depends on
 * knowing which server (and password) it is logged in to, and an unknown login counts as a
 * mismatch. A site that called `api.init` without recording the login would therefore not be
 * wrong, only slow: every later operation would log in again, which is the #127 auth burst that
 * #134 removed. Routing every init through here makes "logged in" and "recorded" one step, and
 * `tests/unit/multi_server_budget_selection.test.js` fails on any raw `api.init(` elsewhere.
 *
 * Order, every time:
 *  1. clear the login and loaded-budget records. Upstream's init points the client at the new
 *     server before it signs in, so a login that throws or times out leaves the client on a
 *     server with nothing proven; clearing first means nothing trusts it afterwards, and the
 *     next operation of any session re-selects.
 *  2. close any open budget with upstream `api.shutdown`, which syncs it first over the OLD
 *     login. Upstream's init does NOT close an open budget, so without this a pending change of
 *     the outgoing budget would next try to sync against the new server. A no-op when nothing is
 *     open (the legacy per-operation cycle has already shut down). Not the pool's shutdown
 *     helpers: those drop pool entries, and the other sessions' entries are still valid.
 *  3. log in, then record the login.
 *
 * Bounded by the op timeout (#270). Callers that retry on the auth rate limit wrap this whole
 * call in `withAuthRetry`, so each attempt is bounded on its own.
 *
 * A timeout does not cancel (`withOpTimeout` races), so a timed-out close or login keeps running
 * after the caller has thrown and released the lock. A late close would close the budget the next
 * operation loaded, in any deployment, so it is always registered with the #393 abandoned-load
 * registry: every `withApiLock` acquisition settles it, bounded and failing closed, before it runs
 * anything. A late login is registered only when the registry names more than one login
 * (`loginsSpanServers`): there it could move the client to another server under the next
 * operation, while with one login it lands on the only server there is, and registering it would
 * replace #270's per-request recovery with a fail-closed wait on every operation. The close
 * has no such exemption: its upstream sync talks to the server, so a close that stalls makes every
 * session wait, bounded and failing closed, in a one-login deployment too (the accepted #393
 * trade-off; making the close and login abortable is #574). Their late
 * success records nothing (the records were cleared in step 1 and `setApiLogin` is only reached by
 * a caller still waiting), so the next operation logs in again.
 */
export async function initApiLoggedIn(dataDir: string, login: ApiLogin, label: string): Promise<void> {
  setApiLogin(null);
  setLoadedBudgetSyncId(null);
  const closing = (api as unknown as { shutdown: () => Promise<void> }).shutdown();
  registerBudgetLoad(closing);
  await withOpTimeout(() => closing, `${label} (close outgoing budget)`);
  const loggingIn = api.init({
    dataDir,
    serverURL: login.serverUrl,
    password: login.password,
  });
  if (loginsSpanServers()) registerBudgetLoad(loggingIn);
  await withOpTimeout(() => loggingIn, label);
  setApiLogin(login);
}

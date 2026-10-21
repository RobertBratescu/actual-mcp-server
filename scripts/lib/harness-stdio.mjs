// #575: the one way a harness script starts a stdio server inside a running container.
//
// `docker exec` inherits the container's MCP_BRIDGE_DATA_DIR=/app/data, the directory the
// live HTTP server is already using. A stdio server started that way is a second
// @actual-app/api writer on the same budget files: its writes sync, then the HTTP
// server's next trailing sync pushes its own stale copy, and every NEW session open fails
// out_of_sync until the local copy is moved out by hand (reproduced on 2026-10-21, see
// #575). `docker exec` also defaults to root while the server runs as `app` (uid 1001),
// leaving root-owned files the server cannot use afterwards.
//
// So every caller names its OWN data dir and runs as `app`. The helper does not pick the
// dir: only the caller knows which paths are writable in ITS container. It refuses
// exactly /app/data; a subdirectory is isolated, because Actual keeps each budget in
// `<dataDir>/<budget id>/` and never reads its parent.
//
// scripts/stdio-framing-check.mjs keeps its own buildDockerArgs (it wraps the server in
// `sh -c` to read the sync id on the E2E stack); tests/unit/harness_stdio_data_dir.test.js
// pins every other caller to this file.
import { execFileSync } from 'child_process';

const SERVER_DATA_DIR = '/app/data';

/**
 * `docker exec` args for a stdio server on its own data dir, as `app`.
 * @param {{ container: string, dataDir: string, env?: Record<string, string|number> }} opts
 */
export function stdioExecArgs({ container, dataDir, env = {} }) {
  if (!container) throw new Error('stdioExecArgs: container is required');
  if (typeof dataDir !== 'string' || !dataDir.startsWith('/')) {
    throw new Error(`stdioExecArgs: dataDir must be an absolute path, got ${JSON.stringify(dataDir)}`);
  }
  if (dataDir.replace(/\/+$/, '') === SERVER_DATA_DIR) {
    throw new Error(`stdioExecArgs: dataDir ${dataDir} is the running server's own ${SERVER_DATA_DIR}; a second process there corrupts its budget copy (#575)`);
  }
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return [
    'exec', '-i',
    '-u', 'app',
    '-e', `MCP_BRIDGE_DATA_DIR=${dataDir}`,
    ...envArgs,
    container, 'node', 'dist/src/index.js', '--stdio',
  ];
}

/**
 * Create the data dir as `app` before the server starts: the adapter's legacy init
 * `scandir`s it, so an absent dir surfaces as ENOENT. Best effort: an unreachable
 * container fails later, at connect, with a clearer error.
 */
export function prepareStdioDataDir(container, dataDir) {
  try {
    execFileSync('docker', ['exec', '-u', 'app', container, 'mkdir', '-p', dataDir], { stdio: 'ignore' });
  } catch (err) {
    console.warn(`  prepareStdioDataDir: could not create ${dataDir} in ${container} as app: ${String(err?.message || err).split('\n')[0]}`);
  }
}

// Pure connectivity-status logic for the /api/hosts/status endpoint.
//
// Extracted from the route handler so it can be unit-tested directly with a
// stubbed `validateHost` (no real SSH required). The behaviour here is identical
// to what the endpoint did inline: derive status/latency/error/timestamp from a
// validateHost result, and never throw — a rejecting validateHost becomes an
// 'offline' result carrying the error message.
//
// `validateHost` is injected (rather than imported) precisely so tests can
// control connectivity outcomes without mocking the module boundary (this repo
// runs on Node 20, where node:test's `mock.module` is unavailable).

/**
 * Check one host and return a structured status object.
 *
 * @param {string} host - host alias, or '(local)' for this machine.
 * @param {(host: string, cfg: object) => Promise<{ok: boolean, error?: string}>} validateHost
 *        - connectivity probe (real one lives in ssh.js).
 * @param {object} cfg - warden config, passed through to validateHost.
 * @returns {Promise<{host: string, status: string, latency_ms: number|null,
 *                     error: (string|undefined), last_check: string}>}
 */
export async function checkHost(host, validateHost, cfg) {
  const start = Date.now();
  try {
    const result = await validateHost(host, cfg);
    return {
      host,
      status: result.ok ? 'online' : 'offline',
      latency_ms: result.ok ? Date.now() - start : null,
      error: result.error,
      last_check: new Date().toISOString(),
    };
  } catch (e) {
    return {
      host,
      status: 'offline',
      latency_ms: null,
      error: e.message,
      last_check: new Date().toISOString(),
    };
  }
}

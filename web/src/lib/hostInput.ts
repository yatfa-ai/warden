// Validation for a HAND-TYPED host in Settings → Hosts & Connection (WARDEN-940).
//
// Until now the only way to add a host was a Select scraped out of ~/.ssh/config
// (`allSshHosts` in src/config.js matches literal `Host` aliases only). A user
// with no ssh config — or a reachable box that isn't a literal alias (a plain
// DNS name, an IP, an alias behind an `Include`) — had no add path at all: the
// whole Add Host block was hidden when the picker had nothing to offer. The
// backend has always accepted any string array (config-schema.js `hosts` is
// `type: 'array'`, no ssh-config validation on the PUT path), so the only thing
// standing between a typed name and a configured host is this local check.
//
// Deliberately LOCAL only: no connectivity probe (WARDEN-915 removed exactly
// that blocking work from this screen), no ssh-config membership test — the
// point is to accept hosts the picker can't see.
//
// Pure (no React, no DOM, no clock) so it is unit-testable. See web/hostInput.test.mjs.
import { THIS_MACHINE } from './chatDisplay';

export type HostInputIssue = 'empty' | 'invalid' | 'this-machine' | 'duplicate';

export type HostInputResult =
  | { ok: true; host: string }
  | { ok: false; issue: HostInputIssue; error: string };

/**
 * Validate a typed host name against the hosts already in the draft config.
 *
 *   - empty / whitespace-only  → rejected ('empty')
 *   - leading '-'              → rejected ('invalid'); ssh is invoked
 *     positionally (`args.push(host, remote)` in src/ssh.js, with no `--`
 *     separator), so a value like `-oProxyCommand=…` is read by ssh as an
 *     OPTION rather than a host and silently does something other than what
 *     the user typed. Not a shell injection — spawn() runs without a shell —
 *     but exactly the silent-swallow this screen exists to eliminate.
 *   - '(local)' (THIS_MACHINE) → rejected ('this-machine'); this machine is
 *     always implied and is deliberately NOT a member of config.hosts (the
 *     display-label list prepends it separately), so adding it would create a
 *     duplicate row that removal could never fully undo.
 *   - already configured       → rejected ('duplicate'); the caller's addHost
 *     silently no-ops on a duplicate, which reads as "the button is broken".
 *   - otherwise                → ok, with the TRIMMED name to store.
 *
 * Every rejection carries a user-facing `error` so the caller can surface it
 * instead of failing silently. The comparison against THIS_MACHINE is
 * case-insensitive ('(LOCAL)' is the same mistake); the duplicate check is
 * exact, matching the `config.hosts.includes(host)` guard it front-runs.
 */
export function validateNewHost(raw: string, configuredHosts: readonly string[]): HostInputResult {
  const host = raw.trim();
  if (host === '') {
    return { ok: false, issue: 'empty', error: 'Enter a host name to add.' };
  }
  if (host.startsWith('-')) {
    return {
      ok: false,
      issue: 'invalid',
      error: `A host name can't start with "-" — ssh would read it as an option.`,
    };
  }
  if (host.toLowerCase() === THIS_MACHINE.toLowerCase()) {
    return {
      ok: false,
      issue: 'this-machine',
      error: `"${THIS_MACHINE}" is this machine — it is always available and can't be added.`,
    };
  }
  if (configuredHosts.includes(host)) {
    return { ok: false, issue: 'duplicate', error: `"${host}" is already configured.` };
  }
  return { ok: true, host };
}

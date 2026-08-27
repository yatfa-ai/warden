// The client-side host list for `GET /api/ssh-hosts` (WARDEN-1202).
//
// That endpoint returns TWO keys and, until this helper existed, every client
// read only one:
//
//   res.json({ hosts: await allSshHosts(), configured: cfg.hosts })
//
//   - `hosts`      — allSshHosts() (src/config.js), which parses `~/.ssh/config`
//                    `Host` aliases ONLY. Its own comment says it is "used for
//                    completion / validation — discovery only scans cfg.hosts".
//   - `configured` — cfg.hosts, the REAL fleet: the array every server-side
//                    sweep iterates as `[LOCAL, ...cfg.hosts]`.
//
// `configured` had zero readers, and that divergence is reachable through a
// SHIPPED affordance rather than a hypothetical config. WARDEN-940 added the
// free-text "Add Host" field in Settings → Hosts, whose stated purpose is
// "accepting hosts the picker cannot see" — it deliberately performs no
// ssh-config membership test. So a typed host lands in cfg.hosts and is BY
// DESIGN absent from ~/.ssh/config. The server then polled, discovered and
// scanned it correctly while every client host list dropped it, producing three
// user-visible failures: no Open Chat scope chip, no sidebar host row (so
// `enterHost` was unreachable), and — worse than omission — NewChatForm
// actively reset a stored `defaultNewChatHost` back to `(local)`, re-seeding
// cwd and preset on every open.
//
// Pure (no React, no DOM, no fetch) so it is unit-testable. See web/hostList.test.mjs.
import { THIS_MACHINE } from './chatDisplay';

/** The shape `/api/ssh-hosts` returns. Both keys are optional defensively — a
 *  pre-WARDEN-1202 server, or a failed/partial response, must degrade to a
 *  shorter list rather than throwing inside a `.then()`. */
export type SshHostsResponse = {
  /** ~/.ssh/config `Host` aliases (completion/validation source). */
  hosts?: string[];
  /** config.json `hosts` — the real fleet the server actually sweeps. */
  configured?: string[];
};

/**
 * Merge the two host sources into the single list the client renders.
 *
 * Order: ssh-config aliases first (preserving the endpoint's order), then any
 * configured-only host not already present. Discovery order is what users have
 * always seen, so appending is the least surprising placement for the newcomers.
 *
 * De-duplication is exact (`hosts` and `cfg.hosts` are compared verbatim, as the
 * server does), so a host present in BOTH files appears exactly once — no
 * duplicate chip or row.
 *
 * `(local)` is filtered from BOTH inputs, case-insensitively. It is never
 * legitimately present: cfg.hosts excludes it by construction (the server
 * composes `[LOCAL, ...cfg.hosts]` explicitly) and allSshHosts can't return it.
 * But every consumer prepends THIS_MACHINE itself (`[THIS_MACHINE, ...sshHosts]`),
 * so a hand-edited config.json containing the literal would otherwise produce a
 * duplicate local entry. Filtering here is the cheap defensive guard that keeps
 * that impossible — matching validateNewHost, which rejects a typed '(local)'
 * case-insensitively for the same reason.
 *
 * NOTE this is for host-LIST consumers (App.tsx's `sshHosts` state, NewChatForm)
 * — deliberately NOT for the Settings "Add Host" picker in useBackendConfig.ts,
 * which must keep offering ssh-config aliases MINUS already-configured hosts.
 * Unioning there would offer hosts that are already configured.
 */
export function mergeHostList(response: SshHostsResponse | null | undefined): string[] {
  const isLocal = (h: string) => h.toLowerCase() === THIS_MACHINE.toLowerCase();
  const discovered = (response?.hosts ?? []).filter((h) => !isLocal(h));
  const configured = (response?.configured ?? []).filter((h) => !isLocal(h));

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const host of [...discovered, ...configured]) {
    if (seen.has(host)) continue;
    seen.add(host);
    merged.push(host);
  }
  return merged;
}

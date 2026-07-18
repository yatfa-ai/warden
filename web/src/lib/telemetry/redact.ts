// Telemetry pre-collection redaction engine — slice 2 of roadmap WARDEN-446
// (INFINITE: "warden-telemetry-client-optional-off-by-default").
//
// Enforces, BY CONSTRUCTION, the WARDEN-443 data-boundary contract: credentials,
// chat content/output, prompts, file paths, and hostnames can NEVER enter the
// telemetry pipeline. The only identifiers ever retained are chat names and
// Claude session names, and only when the effective consent tier is `extended`.
// This runs at the COLLECTION BOUNDARY — pre-buffer / pre-queue / pre-serialize
// (Principle #3 of WARDEN-443) — so nothing un-redacted is ever retained in
// memory or on disk. It is a client-side certainty, not a server-side hope.
//
// This slice is deliberately INDEPENDENT of slice 1 (WARDEN-457, the schema +
// consent gate): it operates on the field-shape CONTRACT (categories of fields +
// the tier model) inlined below, not on slice 1's implementation. Pipeline
// assembly (schema → redact → consent-gate → transport) is a later slice. There
// is no transport here — this module produces a scrubbed copy and nothing more.
//
// The module is PURE and ZERO-DEPENDENCY: no runtime imports (types are brought
// in via `import type`, which the Vite OXC transform erases), so it loads
// standalone under `node --test` for direct unit coverage — see
// web/telemetry-redact.test.mjs, mirroring web/desktopAlerts.test.mjs's harness.
// Co-located with slice 1's planned module per WARDEN-457's authoritative
// location decision (web/src/lib/telemetry/).

// ---------------------------------------------------------------------------
// THE REDACTION CONTRACT (spec — verbatim from WARDEN-443, "Data boundaries")
// ---------------------------------------------------------------------------
// Hard exclusions — NEVER collected or sent, at ANY tier (strip before any
// payload is buffered / queued / serialized):
//   • API keys        — AWS access-key-id (AKIA…), GitHub tokens (ghp_/gho_/…),
//                       plus known-format (OpenAI sk-, Stripe, Slack, Google AIza)
//                       and generic high-entropy secret strings.
//   • Auth tokens     — `Authorization: Bearer/Basic …` header values, bare
//                       `Bearer …`, and labeled secrets (`password=`, `api_key:`…).
//   • SSH keys        — PEM private-key blocks (`-----BEGIN … PRIVATE KEY-----`).
//   • Chat content    — chat output / messages / transcript. Dropped WHOLESALE,
//                       never partially scrubbed (content is categorically out).
//   • Prompts         — prompt / prompt-template fields. Dropped wholesale.
//   • File paths      — absolute + home-relative, POSIX (`/…`, `~/…`) and
//                       Windows (`C:\…`, `\\server\share\…`).
//   • Hostnames       — FQDN (`host.corp.local`), `user@host` (email / SSH),
//                       scheme URLs (`ssh://`, `https://`, `postgres://` …), and
//                       IP addresses (IPv4 `10.0.0.5` AND IPv6 `fe80::1` /
//                       `2001:db8::1`). Persistent device identifiers such as MAC
//                       addresses (`00:1A:2B:3C:4D:5E`) are scrubbed in the same
//                       host/device pass — they reveal network topology too.
//
// Identifiers permitted ONLY at the extended tier: chat name + Claude session
// name. CONTENT IS NEVER SENT — names only, never content.
//
// Tier semantics (from the WARDEN-443 consent model):
//   • base      — anonymous error/crash/performance events. NO identifiers.
//   • extended  — (gated behind base) additionally retains chat + session names.
//   • off / unknown / undefined — default to MOST-REDACTED (drop names). When in
//                 doubt, strip more; never default to retaining identifiers.
// ---------------------------------------------------------------------------

/**
 * The effective telemetry consent tier, resolved from the user's Settings
 * consent (slice 1 produces this; this module only consumes it).
 *
 *  - `'base'`     — anonymous events only; identifiers dropped.
 *  - `'extended'` — additionally retains chat/session names.
 *  - `'off'`      — telemetry disabled; treated as most-redacted (names dropped).
 *
 * Any unrecognized / undefined value is treated as most-redacted, so a missing
 * or corrupt consent value can never accidentally retain identifiers.
 */
export type ConsentTier = 'base' | 'extended' | 'off';

export interface RedactOptions {
  /** Effective consent tier. Anything other than `'extended'` drops identifiers. */
  tier?: ConsentTier;
}

/**
 * Field names whose value is categorically chat CONTENT / prompts. These are
 * hard-excluded at every tier and are dropped WHOLESALE (never partially
 * scrubbed) — content must never enter the pipeline, by name or by substring.
 * Matched case-insensitively against the lowercased key.
 */
export const CONTENT_FIELDS: ReadonlySet<string> = new Set([
  'content',
  'output',
  'prompt',
  'prompts',
  'response',
  'completion',
  'completions',
  'messages',
  'chatcontent',
  'chatoutput',
  'chathistory',
  'history',
  'conversation',
  'transcript',
]);

/**
 * Identifier field names — chat / session names. Retained ONLY when the
 * effective tier is `'extended'`; dropped (absent from the output) at base /
 * off / unknown. Matched case-insensitively against the lowercased key.
 */
export const IDENTIFIER_FIELDS: ReadonlySet<string> = new Set([
  'chatname',
  'sessionname',
  'chattitle',
  'sessiontitle',
]);

/**
 * The pure, deterministic redaction transform.
 *
 * Takes a candidate event / field-bag plus the effective consent tier and returns
 * a SCRUBBED COPY — the input is never mutated. Content/prompt fields are
 * dropped wholesale (all tiers); chat/session-name fields are kept only at the
 * extended tier; every remaining string value is passed through {@link scrubString}
 * so no credential, path, or hostname can survive in free text (e.g. an error
 * message or stack trace). Numbers / booleans / null pass through untouched.
 *
 * Unrecognized, undefined, or `'off'` tiers yield the MOST-REDACTED output
 * (names dropped) — the module makes it impossible for an un-redacted payload to
 * be produced regardless of caller.
 *
 * Idempotent: redacting already-redacted output is a no-op.
 */
export function redact(payload: unknown, opts: RedactOptions = {}): unknown {
  const allowNames = opts.tier === 'extended';
  return scrubValue(payload, allowNames);
}

// Source-code file extensions (lowercased, no leading dot). A stack frame's
// `file`/`function` basename whose FINAL dot-segment is in this set is a source
// filename, NOT a hostname, and must survive the FQDN rule (WARDEN-680). The
// discriminator is the final dot-segment only: `server.js` → `js` (preserve),
// `api.github.com` → `com` (redact), `prod-db-01.corp.local` → `local` (redact).
// Several suffixes are simultaneously source extensions AND country-code TLDs
// (`.ts`/Tunisia, `.py`/Paraguay, `.rs`/Serbia, `.sh`/Saint Helena, `.pl`/…);
// that collision is harmless because this set is consulted ONLY in the
// structured frame-field scrub path (the value was extracted from a real file
// path by basename()) — never in generic free text. 1-char extensions (`.c`,
// `.h`, `.s`) never reach rule 8 (its regex floor is `[A-Za-z]{2,}`), so they
// are auto-preserved and intentionally omitted here.
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'js', 'jsx', 'ts', 'tsx', 'cjs', 'mjs', 'mts', 'json', 'json5', 'jsonc',
  'html', 'htm', 'css', 'scss', 'sass', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'go', 'rs', 'java', 'rb', 'cs', 'cpp', 'cc', 'cxx', 'hpp', 'hxx',
  'php', 'swift', 'kt', 'scala', 'lua', 'pl', 'sh', 'bash', 'zsh', 'ps1',
  'sql', 'graphql', 'proto', 'toml', 'yaml', 'yml', 'ini', 'cfg', 'conf',
  'env', 'map',
]);

// True iff `token`'s final dot-segment (lowercased) is a known source extension.
// No length / multi-dot games — `telemetry-pipeline.cjs` → `cjs`, `App.tsx` →
// `tsx`, `api.github.com` → `com` (not a source extension). Rule 8 only invokes
// this on a regex match whose tail is `[A-Za-z]{2,}`, so `ext` is always ≥2
// alpha chars; a digit-bearing suffix (`node.12`) never matches rule 8 and so
// never reaches here.
function isSourceFilename(token: string): boolean {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  return SOURCE_EXTENSIONS.has(token.slice(dot + 1).toLowerCase());
}

/**
 * The value-level recognizer pipeline. Applied to every retained string in a
 * payload (and exported for direct unit testing of each rule). Returns a new
 * string; never mutates. Every replacement is an inert placeholder — it contains
 * no secret / path / host pattern, so re-running is a no-op (idempotent).
 *
 * `preserveSourceFilenames` (set ONLY for a stack frame's `file`/`function` by
 * scrubValue) makes rule 8 leave a source basename (`server.js`, `App.tsx`)
 * intact instead of `[REDACTED:host]`-ing it — see WARDEN-680. It defaults off,
 * so all generic free-text redaction is byte-identical regardless of caller.
 *
 * Rules run most-specific-first so a credential is fully replaced before any
 * later structural (path / host) rule could partially mangle it.
 */
export function scrubString(value: string, preserveSourceFilenames?: boolean): string {
  if (typeof value !== 'string' || value.length === 0) return value;
  let out = value;

  // 1. PEM private-key blocks (may span many lines — RSA / EC / OPENSSH / PGP …).
  out = out.replace(
    /-----BEGIN (?:[A-Z0-9][A-Z0-9 ]*)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9][A-Z0-9 ]*)?PRIVATE KEY-----/g,
    '[REDACTED:private-key]',
  );

  // 2. Scheme URLs — the whole `scheme://…` run is a host identifier (the
  //    authority, port, path, and any embedded userinfo/secret go together).
  out = out.replace(
    /\b(?:https?|ftp|sftp|ssh|git|ws|wss|redis|rediss|postgres|postgresql|mongodb|amqp|mysql|mssql):\/\/[^\s'"<>`)\]}]+/gi,
    '[REDACTED:host]',
  );

  // 3. Known-format credentials.
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'); // AWS access key id
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, '[REDACTED:github-token]'); // GitHub token
  out = out.replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED:secret]'); // OpenAI / Anthropic
  out = out.replace(/\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED:secret]'); // Stripe
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:secret]'); // Slack
  out = out.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:secret]'); // Google API key
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT (three base64url segments)
    '[REDACTED:secret]',
  );

  // 4. Generic high-entropy secret — a long (≥20) mixed-class run from the
  //    secret charset is almost certainly a raw key / secret (AWS secret access
  //    keys, random API tokens, hashes). Requires ≥2 of {lower, upper, digit} so
  //    ordinary lowercase words, pure numbers, and version strings are left alone.
  //    `=` is deliberately EXCLUDED so a log `label=number` (e.g. `timestamp=…`,
  //    `duration_ms=…`) is not glued into a fake secret — base64 padding `=` is
  //    trailing, so excluding it never prevents a real base64 secret's body from
  //    matching.
  out = out.replace(/[A-Za-z0-9_~+/-]{20,}/g, (m) => {
    const classes =
      (/[a-z]/.test(m) ? 1 : 0) + (/[A-Z]/.test(m) ? 1 : 0) + (/[0-9]/.test(m) ? 1 : 0);
    return classes >= 2 ? '[REDACTED:secret]' : m;
  });

  // 5. Labeled / header credentials — value redacted. Runs after the format +
  //    entropy rules so an already-replaced token is not re-handled. Bare
  //    `Bearer|Basic|Token|Mac <value>` and named-secret labels (`password=`,
  //    `api_key:`, …) keep their label word (debuggable); a full `Authorization:`
  //    header is replaced wholesale — the label is itself a credential marker and
  //    is dropped, not retained.
  out = out.replace(
    /\b(Bearer|Basic|Token|Mac)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    '$1 [REDACTED:token]',
  );
  out = out.replace(
    /\b(password|passwd|secret|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|api[_-]?secret|private[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s"';,]+)/gi,
    '$1=[REDACTED:secret]',
  );
  out = out.replace(
    /\b(authorization|proxy-authorization)\s*[:=]\s*[^\n"';,)]+/gi,
    '[REDACTED:token]',
  );

  // 6. File paths — structural, run BEFORE hostnames so a path containing a
  //    dotted filename (`server.js`, `secrets.txt`) is consumed whole as a path,
  //    not split off as an FQDN-shaped `[REDACTED:host]` fragment. POSIX absolute
  //    + home-relative (all-numeric matches like a date fragment are skipped — a
  //    real path has a letter); Windows drive (`C:\…`) + UNC (`\\server\share\…`).
  out = out.replace(/(?:~\/|\/)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?/g, (m) =>
    /[A-Za-z]/.test(m) ? '[REDACTED:path]' : m,
  );
  out = out.replace(
    /[A-Za-z]:\\[A-Za-z0-9._-]+(?:\\[A-Za-z0-9._-]+)*|\\\\[A-Za-z0-9._-]+(?:\\[A-Za-z0-9._-]+)+/g,
    '[REDACTED:path]',
  );

  // 7. user@host — email or SSH target. Runs BEFORE FQDN/IP so the local-part is
  //    not leaked as a bare word when the host half is redacted.
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\b/g, '[REDACTED:host]');

  // 8. FQDN / dotted hostnames (`api.github.com`, `db.internal.corp.local`).
  //    When `preserveSourceFilenames` is set (ONLY for a stack frame's
  //    `file`/`function` — see scrubValue), a token whose final dot-segment is a
  //    known source extension (`server.js`, `App.tsx`, `telemetry-pipeline.cjs`)
  //    is a source basename, not a hostname, and is left intact; a real
  //    host-shaped value (`api.github.com` → `.com`, `prod-db-01.corp.local` →
  //    `.local`) is still redacted. The scoping is what keeps generic free-text
  //    redaction byte-identical AND sidesteps the ccTLD collision (`.ts`/`.py`/
  //    `.rs` are both source extensions AND country-code TLDs) — only the
  //    structured frame context, where the value came from a real file path,
  //    ever preserves them. (WARDEN-680.)
  out = out.replace(
    /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}\b/g,
    (m) => (preserveSourceFilenames && isSourceFilename(m) ? m : '[REDACTED:host]'),
  );

  // 9. IPv4 addresses (4-octet — avoids dates / versions / times).
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED:host]');

  // 10. IPv6 addresses (+ MAC / device identifiers). Once IPs are treated as
  //     host identifiers (rule 9), IPv6 must not ride out — `fe80::1`,
  //     `2001:db8::1`, `::1`, and full 8-hextet forms all leak internal network
  //     topology (link-local, ULA) the contract exists to prevent. The candidate
  //     grabs any colon-hex run with ≥2 colons (optionally a trailing `%zone`);
  //     the validator (looksLikeIPv6) keeps clock times (`12:34:56`) and short
  //     hex spans out. The same pass catches MAC addresses (`00:1A:2B:3C:4D:5E`,
  //     6 hex hextets) — a MAC is a persistent device identifier, so it is
  //     redacted in the host/device pass rather than left to leak.
  out = out.replace(
    /[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,}(?:%[A-Za-z0-9._-]+)?/g,
    (m) => (looksLikeIPv6(m) ? '[REDACTED:host]' : m),
  );

  return out;
}

/**
 * Validator for the IPv6 candidate (rule 10). Keeps false positives off clock
 * times and ordinary hex spans: a token is an IPv6/host identifier if it uses
 * `::` zero-compression, has ≥4 hextets (≥3 colons — full IPv6 and MACs), or —
 * at exactly 3 hextets — carries a hex letter (so `12:34:56` survives but
 * `2001:db8:feed` does not). A `%zone` scope id (`fe80::1%eth0`) is dropped
 * before the check. The candidate already requires ≥2 colons, so a lone
 * `label:value` (`key:ABCD`) and the inert `[REDACTED:host]` placeholder (one
 * colon) never reach this function as real candidates.
 */
function looksLikeIPv6(token: string): boolean {
  const addr = token.split('%')[0]; // drop a trailing %zone (link-local scope id)
  const colonCount = (addr.match(/:/g) || []).length;
  if (colonCount < 2) return false; // safety: not address-shaped
  const hasCompression = addr.includes('::');
  const hasHexLetter = /[a-fA-F]/.test(addr);
  return hasCompression || colonCount >= 3 || hasHexLetter;
}

// Deep scrub of a single value. Builds a fresh copy at every level so the input
// tree is never mutated. `allowNames` is whether the effective tier permits
// chat/session-name identifiers (only true at the extended tier). `preserveSource`
// is set ONLY while scrubbing a stack frame's `file`/`function` fields so a
// source basename survives rule 8 (WARDEN-680) — it is never set for generic
// free text, which stays byte-identical to before.
function scrubValue(value: unknown, allowNames: boolean, preserveSource?: boolean): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value, preserveSource);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, allowNames, false));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = String(k);
      const lower = key.toLowerCase();
      // Content / prompts: hard-excluded at every tier — drop wholesale.
      if (CONTENT_FIELDS.has(lower)) continue;
      // Chat / session names: retained ONLY at the extended tier.
      if (IDENTIFIER_FIELDS.has(lower)) {
        if (!allowNames) continue;
        out[key] = scrubValue(v, allowNames, false); // kept; still scrubbed for embedded secrets
        continue;
      }
      // Structured stack frames (schema: `frames: StackFrame[]`). A frame's
      // `file`/`function` carry a source basename (the directory was dropped at
      // the collection boundary via basename()); preserve its extension through
      // the FQDN rule (WARDEN-680). Detection is scoped to the `frames` array so
      // ONLY a frame's `file`/`function` ever scrub with preserveSource=true —
      // generic free text and the frame's other fields (`line`/`column`) are
      // byte-identical to before.
      if (lower === 'frames' && Array.isArray(v)) {
        out[key] = v.map((frame) => scrubValue(frame, allowNames, true));
        continue;
      }
      if (preserveSource && (lower === 'file' || lower === 'function')) {
        out[key] = scrubValue(v, allowNames, true);
        continue;
      }
      out[key] = scrubValue(v, allowNames, false); // recurse into nested / scrub strings
    }
    return out;
  }
  return value; // number / boolean / bigint — not secret-shaped, pass through
}

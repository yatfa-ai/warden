'use strict';

// Telemetry pre-collection redaction engine — CJS MIRROR of
// web/src/lib/telemetry/redact.ts (slice 2 of roadmap WARDEN-446 / design
// WARDEN-443). This is the tiered redactor the live main-process pipeline needs.
//
// WHY A CJS MIRROR (and not a require() of redact.ts):
// The live call site is electron/main.cjs (CommonJS, runs in the Electron MAIN
// process). redact.ts lives in web/src/lib/telemetry/ (TypeScript/ESM), and there
// is no TS→CJS runtime build available to a packaged app (vite is a devDependency
// that emits a browser bundle, not Node modules) — so main.cjs cannot require()
// the .ts file at runtime. This is exactly the boundary telemetry-pipeline.cjs's
// own comments flag (lines 57–68). The same situation already produced
// electron/telemetry-source.cjs (a CJS copy of the schema contract); this module
// follows that established pattern for the redactor.
//
// This file is a FAITHFUL, LINE-FOR-LINE port of redact.ts: the field sets, the
// scrubString rule order, the IPv6 validator, and the recursive scrubValue are all
// identical. web/telemetry-redact-cjs-parity.test.mjs guards the mirror against
// drift by asserting deepEqual equality against the REAL redact.ts (loaded via
// Vite's OXC transform) across a battery of inputs + every tier — so a future
// edit to either file that diverges them fails the suite.
//
// Everything here is PURE and ZERO-DEPENDENCY so it loads standalone under
// `node --test` (same as telemetry-source.cjs / window-state.cjs).

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

// Field names whose value is categorically chat CONTENT / prompts. These are
// hard-excluded at every tier and are dropped WHOLESALE (never partially
// scrubbed) — content must never enter the pipeline, by name or by substring.
// Matched case-insensitively against the lowercased key.
const CONTENT_FIELDS = new Set([
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

// Identifier field names — chat / session names. Retained ONLY when the
// effective tier is 'extended'; dropped (absent from the output) at base /
// off / unknown. Matched case-insensitively against the lowercased key.
const IDENTIFIER_FIELDS = new Set([
  'chatname',
  'sessionname',
  'chattitle',
  'sessiontitle',
]);

// The pure, deterministic redaction transform.
//
// Takes a candidate event / field-bag plus the effective consent tier and returns
// a SCRUBBED COPY — the input is never mutated. Content/prompt fields are
// dropped wholesale (all tiers); chat/session-name fields are kept only at the
// extended tier; every remaining string value is passed through scrubString so no
// credential, path, or hostname can survive in free text (e.g. an error message
// or stack trace). Numbers / booleans / null pass through untouched.
//
// Unrecognized, undefined, or 'off' tiers yield the MOST-REDACTED output (names
// dropped) — the module makes it impossible for an un-redacted payload to be
// produced regardless of caller.
//
// Idempotent: redacting already-redacted output is a no-op.
function redact(payload, opts) {
  const o = opts || {};
  const allowNames = o.tier === 'extended';
  return scrubValue(payload, allowNames);
}

// The value-level recognizer pipeline. Applied to every retained string in a
// payload (and exported for direct unit testing of each rule). Returns a new
// string; never mutates. Every replacement is an inert placeholder — it contains
// no secret / path / host pattern, so re-running is a no-op (idempotent).
//
// Rules run most-specific-first so a credential is fully replaced before any
// later structural (path / host) rule could partially mangle it.
function scrubString(value) {
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
  out = out.replace(
    /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}\b/g,
    '[REDACTED:host]',
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

// Validator for the IPv6 candidate (rule 10). Keeps false positives off clock
// times and ordinary hex spans: a token is an IPv6/host identifier if it uses
// `::` zero-compression, has ≥4 hextets (≥3 colons — full IPv6 and MACs), or —
// at exactly 3 hextets — carries a hex letter (so `12:34:56` survives but
// `2001:db8:feed` does not). A `%zone` scope id (`fe80::1%eth0`) is dropped
// before the check. The candidate already requires ≥2 colons, so a lone
// `label:value` (`key:ABCD`) and the inert `[REDACTED:host]` placeholder (one
// colon) never reach this function as real candidates.
function looksLikeIPv6(token) {
  const addr = token.split('%')[0]; // drop a trailing %zone (link-local scope id)
  const colonCount = (addr.match(/:/g) || []).length;
  if (colonCount < 2) return false; // safety: not address-shaped
  const hasCompression = addr.includes('::');
  const hasHexLetter = /[a-fA-F]/.test(addr);
  return hasCompression || colonCount >= 3 || hasHexLetter;
}

// Deep scrub of a single value. Builds a fresh copy at every level so the input
// tree is never mutated. `allowNames` is whether the effective tier permits
// chat/session-name identifiers (only true at the extended tier).
function scrubValue(value, allowNames) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, allowNames));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = String(k);
      const lower = key.toLowerCase();
      // Content / prompts: hard-excluded at every tier — drop wholesale.
      if (CONTENT_FIELDS.has(lower)) continue;
      // Chat / session names: retained ONLY at the extended tier.
      if (IDENTIFIER_FIELDS.has(lower)) {
        if (!allowNames) continue;
        out[key] = scrubValue(v, allowNames); // kept; still scrubbed for embedded secrets
        continue;
      }
      out[key] = scrubValue(v, allowNames); // recurse into nested / scrub strings
    }
    return out;
  }
  return value; // number / boolean / bigint — not secret-shaped, pass through
}

module.exports = {
  CONTENT_FIELDS,
  IDENTIFIER_FIELDS,
  redact,
  scrubString,
};

// WARDEN-1896 — Origin / Host guards for the loopback-bound warden server.
//
// Warden has no auth, and browsers apply no same-origin policy to WebSocket
// handshakes, so without these checks any web page the user visits can open
// ws://127.0.0.1:<port>/api/stream and drive a tmux PTY (cross-site WebSocket
// hijack), and a DNS-rebound page can read every /api/* route (Host is
// attacker-controlled there). Loopback binding does not help against the
// user's own browser.
//
// Pure, side-effect-free predicates + one tiny Express middleware factory.
// Deliberately NOT port-pinned: Electron uses a runtime PORT and the Vite dev
// proxy sends `Origin: http://localhost:5173`.

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

// Normalise a hostname: lowercase, strip IPv6 brackets.
function normHostname(h) {
  let s = String(h).toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  return s;
}

// Hostname of a Host header value ("host", "host:port", "[v6]", "[v6]:port"),
// or null when unparsable.
export function hostnameOfHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string') return null;
  const s = hostHeader.trim();
  if (!s) return null;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return null;
    const rest = s.slice(end + 1);
    if (rest !== '' && !/^:\d*$/.test(rest)) return null;
    return normHostname(s.slice(0, end + 1));
  }
  const colon = s.indexOf(':');
  if (colon >= 0) {
    // More than one colon outside brackets is not a valid Host header.
    if (s.indexOf(':', colon + 1) >= 0) return null;
    if (!/^\d*$/.test(s.slice(colon + 1))) return null;
    return normHostname(s.slice(0, colon));
  }
  return normHostname(s);
}

// Origin header: absent → allow (non-browser clients — the CLI, companion, `ws`
// based tests — never send Origin). Present → must be an http(s) URL whose
// hostname is loopback. `null` / unparsable / lookalike → reject.
export function isAllowedOrigin(originHeader) {
  if (originHeader === undefined || originHeader === null) return true;
  if (typeof originHeader !== 'string') return false;
  let u;
  try { u = new URL(originHeader); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return LOOPBACK_HOSTNAMES.has(normHostname(u.hostname));
}

// Host header: hostname must be loopback or equal to the address the server is
// actually bound to (so a deliberate non-loopback bind keeps working). A MISSING
// Host (HTTP/1.0) is allowed: a DNS-rebinding browser always sends Host, so
// absence is not an attack vector. A present-but-unparsable Host is rejected.
export function isAllowedHost(hostHeader, boundHost) {
  if (hostHeader === undefined || hostHeader === null) return true;
  const name = hostnameOfHostHeader(hostHeader);
  if (!name) return false;
  if (LOOPBACK_HOSTNAMES.has(name)) return true;
  if (typeof boundHost === 'string' && boundHost && name === normHostname(boundHost)) return true;
  return false;
}

// The bound address of an http server (undefined before listen / on a pipe).
export function boundHostOf(server) {
  try {
    const a = server.address();
    return a && typeof a === 'object' ? a.address : undefined;
  } catch { return undefined; }
}

// Express middleware: 403 any request whose Host is not loopback / the bound
// address. `getBoundHost` is a thunk because the bind happens after module load.
export function hostGuardMiddleware(getBoundHost) {
  return (req, res, next) => {
    if (isAllowedHost(req.headers.host, getBoundHost?.())) return next();
    res.status(403).type('text/plain').send('Forbidden: unexpected Host header');
  };
}

// WARDEN-1902 — HTTP Origin guard for state-changing routes. Browsers send
// CORS-simple requests (text/plain or body-less cross-site POSTs) with NO
// preflight and the server executes them even though the response is unreadable;
// the Host guard does not stop this (the attacker posts to 127.0.0.1/localhost,
// an allowed Host). Safe methods pass; every other method needs an allowed (or
// absent) Origin. No CORS headers, no tokens.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export function originGuardMiddleware() {
  return (req, res, next) => {
    if (SAFE_METHODS.has(String(req.method).toUpperCase())) return next();
    if (isAllowedOrigin(req.headers.origin)) return next();
    res.status(403).type('text/plain').send('Forbidden: unexpected Origin header');
  };
}

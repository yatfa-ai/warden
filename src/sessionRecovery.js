// Dead/unreachable session recovery (WARDEN-231).
//
// classifyProbe turns a raw probeSession() result ({ok,code,stdout,stderr}) into
// the pane attach reason the /api/stream handler emits to the frontend:
//   probe.ok                  → null                (session alive; attach normally)
//   !ok && isTransportFailure → 'host_unreachable'  (SSH couldn't deliver the probe,
//                                                   or the probe timed out)
//   !ok && !transport         → 'session_dead'      (host answered; tmux itself
//                                                   reported the session absent)
//
// Kept in its own module (not server.js) so it can be unit-tested without
// importing the server — which matters because importing server.js evaluates
// config.js's path constants against HOME, so a test that needs HOME isolation
// must defer that import to inside its setup hook.
import { isTransportFailure } from './ssh.js';

export function classifyProbe(probe) {
  if (!probe) return null;
  if (probe.ok) return null;
  return isTransportFailure(probe) ? 'host_unreachable' : 'session_dead';
}

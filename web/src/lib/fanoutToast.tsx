import { toast } from 'sonner';
import type { FanoutToast } from './fanout';

/**
 * Render the result toast for a fan-out operation (bulk kill / broadcast /
 * key-send) — the single render seam for every `format*Toast` output.
 *
 * The pure seam was already shared (summarizeFanout + the three formatters in
 * ./fanout, ./kill, ./broadcast, ./keysend); this is the render half, which was
 * hand-copied at five call sites across ChatSidebar and HealthDashboard until
 * WARDEN-935 collapsed them here.
 *
 * WHY THE `whitespace-pre-line` WRAPPER IS LOAD-BEARING — this is the whole
 * reason the render is worth sharing. The formatters build `description` by
 * `\n`-joining one line per failed agent ("agent-a: host unreachable"). Sonner's
 * default description element normalizes whitespace, so WITHOUT this wrapper the
 * per-agent failure list silently collapses into a single run-on line — exactly
 * the output a human reads after a partially-failed bulk kill, degraded with no
 * error and no test failure. It used to be an unenforced contract every caller
 * had to remember (and only two of the three formatters even documented it);
 * living here, it is structural.
 *
 * `enabled` is the caller's notification preference (`prefs.notifyChatOps`).
 * Passing it in rather than gating outside keeps every call site one line and
 * makes the suppression uniform — no site can forget the check.
 */
export function showFanoutToast(outcome: FanoutToast, enabled: boolean) {
  if (!enabled) return;
  if (outcome.variant === 'success') {
    toast.success(outcome.title);
    return;
  }
  toast.error(outcome.title, {
    description: <span className="whitespace-pre-line">{outcome.description}</span>,
  });
}

import { toast } from 'sonner';
import { copyText } from './clipboard';

/**
 * Copy via the Electron-safe helper + a sonner success/error toast — the
 * feedback layer every themed right-click Copy slice needs.
 *
 * `clipboard.ts` deliberately owns only the mechanism and leaves UI feedback to
 * the caller so it stays free of UI deps and unit-testable against mocked
 * globals (clipboard.ts:10-12). That left this 4-line wrapper hand-copied at 16
 * call sites — twice hoisted to module scope locally (GitBadges,
 * SessionTranscriptViewer, each naming the siblings it was duplicating) before
 * it was lifted here. Same split as fanoutToast.tsx: the pure seam in one
 * module, the sonner-coupled half beside it.
 *
 * NOT for the success-only Copy variants (DirectiveHistory, ActivityTimeline,
 * ObserverPanel's pref-gated `copyAndNotify`): those deliberately ignore the
 * boolean and never surface a failure toast, so routing them here would be a
 * UX change, not a refactor.
 *
 * Returns the underlying `copyText` boolean so a caller that needs to branch
 * further still can.
 */
export async function copyWithToast(text: string): Promise<boolean> {
  const ok = await copyText(text);
  if (ok) toast.success('Copied');
  else toast.error('Copy failed');
  return ok;
}

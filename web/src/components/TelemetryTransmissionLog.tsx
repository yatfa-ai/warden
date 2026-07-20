// Recent send outcomes — verifiability's THIRD leg (WARDEN-668). The promise
// (describeCollection) and the preview (previewPayload) ship in
// TelemetryTransparency.tsx; this is what ACTUALLY landed on the wire. It reads
// the bounded, session-scoped, in-memory ring the pipeline already records on
// every real send (WARDEN-583) over the telemetry:transmission-log IPC bridge
// (WARDEN-668), and renders it read-only.
//
// Mounted as a sibling INSIDE TelemetryTransparency's outer container so all
// three verifiability legs share one trust surface (promise → preview → actual).
//
// Boundaries (the clean part): READ-ONLY — it displays `entries()` (a snapshot
// the main handler copies out), so it can never mutate pipeline state. No new
// consent flag, no transport change, no new data leaving the machine — this only
// makes already-recorded, user-owned, metadata-only data visible to the user who
// owns it. No durability (a durable on-disk audit log is a later slice).
//
// Three honest states: (a) entries present → rows; (b) empty ring → "no sends
// this session yet"; (c) bridge absent (browser/dev/smoke) → the same empty
// state, never a crash (the accessor degrades to []). A refresh interval keeps
// the list current as sends land while Settings is open; cleared on unmount.
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Check, HelpCircle, X } from 'lucide-react';
import { formatAbsoluteFull, formatRelative } from '@/lib/formatTimestamp';
import {
  getTelemetryTransmissionLog,
  type TransmissionLogEntry,
} from '@/lib/electron';
import {
  describeTransmissionEntry,
  summarizeTransmission,
} from '@/lib/telemetry/transmission-display';
import { useVisiblePoller } from '@/lib/useVisiblePoller';

// Re-pull cadence while the panel is open — newly-landed sends appear without
// reopening Settings. Cheap: the ring is bounded (cap 200) and the handler
// returns a snapshot. A pull interval is sufficient for this slice; a main→
// renderer PUSH (the broadcastTelemetryRuntimeStatus pattern) is a later
// refinement if sub-second liveness is ever wanted.
const REFRESH_MS = 5000;

export function TelemetryTransmissionLog() {
  // null = the initial pull has not resolved yet (distinct from [] = the ring is
  // empty / the bridge is absent). Without the tri-state, a momentarily-empty
  // ring on mount would flash the "no sends" message before the first pull
  // resolves — a flicker that reads as "data vanished".
  const [entries, setEntries] = useState<TransmissionLogEntry[] | null>(null);

  const pull = () => {
    // Never rejects: degrades to [] when the bridge is absent or throws, so a
    // non-Electron host (browser/dev/smoke) shows the honest empty state.
    getTelemetryTransmissionLog().then((next) => setEntries(next));
  };
  // Poll every REFRESH_MS, gated on Page Visibility so a backgrounded Warden
  // window never burns an IPC ring snapshot + hidden-panel re-render every 5s for
  // a Settings panel no one is looking at — the same invariant every other poller
  // in the app applies. On regaining focus we pull immediately because state may
  // be stale while hidden; the initial mount-pull seeds a window opened after
  // sends landed. (WARDEN-736 / WARDEN-668; consolidated WARDEN-753.) The
  // cancelled guard the inline effect carried is dropped — React 19 treats a
  // setState after unmount as a silent no-op (equivalent semantics).
  useVisiblePoller(pull, REFRESH_MS, []);

  const loading = entries === null;
  // Newest-first — the most recent send outcome is the most useful at the top.
  // slice() first so the snapshot copy is not mutated by the in-place sort.
  const rows = (entries ?? []).slice().sort((a, b) => b.timestamp - a.timestamp);
  const summary = summarizeTransmission(entries ?? []);

  return (
    <div className="flex flex-col gap-2" data-telemetry-transmission-log>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-foreground">Recent send outcomes</h4>
        {!loading && summary.total > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {summary.delivered > 0 && (
              <Badge
                variant="outline"
                className="gap-1 border-green-500/40 text-green-600 dark:text-green-400"
              >
                <Check className="size-3" aria-hidden />
                {summary.delivered} delivered
              </Badge>
            )}
            {summary.dropped > 0 && (
              <Badge variant="outline" className="gap-1 border-destructive/40 text-destructive">
                <X className="size-3" aria-hidden />
                {summary.dropped} dropped
              </Badge>
            )}
            {summary.rejected > 0 && (
              <Badge
                variant="outline"
                className="gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400"
              >
                <AlertTriangle className="size-3" aria-hidden />
                {summary.rejected} rejected
              </Badge>
            )}
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        A local, read-only record of the telemetry sends that actually left this machine this session —
        populated live from the same log the pipeline records on every send. Metadata only: destination host,
        outcome, attempt count, last HTTP status, and event count. No payload content is ever stored.
      </p>

      {loading ? (
        <p className="text-[11px] text-muted-foreground/60">Loading send outcomes…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-background/50 px-2.5 py-2 text-[11px] text-muted-foreground">
          No sends this session yet — actual send outcomes will appear here. If telemetry is off, no endpoint
          is configured, or no event has triggered a send, the log stays empty by design.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((entry, i) => {
            const d = describeTransmissionEntry(entry);
            return (
              <li
                key={`${d.timestamp}-${i}`}
                className="flex flex-wrap items-center gap-1.5 text-[11px]"
              >
                {/*
                  The label text comes from `d.outcomeLabel` — the SINGLE source
                  of truth (set in describeTransmissionEntry), so a label change
                  is one edit and the descriptor's outcomeLabel tests genuinely
                  cover the user-visible string. outcomeTone only drives the
                  icon + color (green Check / red X / amber AlertTriangle / muted
                  HelpCircle) — four distinct render paths, not a duplicated label
                  mapping. The amber AlertTriangle is the pre-send 'rejected'
                  outcome (WARDEN-817), visually distinct from a transport 'dropped'.
                */}
                {d.outcomeTone === 'ok' ? (
                  <span className="inline-flex items-center gap-1 font-medium text-green-600 dark:text-green-400">
                    <Check className="size-3 shrink-0" aria-hidden />
                    {d.outcomeLabel}
                  </span>
                ) : d.outcomeTone === 'dropped' ? (
                  <span className="inline-flex items-center gap-1 font-medium text-destructive">
                    <X className="size-3 shrink-0" aria-hidden />
                    {d.outcomeLabel}
                  </span>
                ) : d.outcomeTone === 'rejected' ? (
                  <span className="inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="size-3 shrink-0" aria-hidden />
                    {d.outcomeLabel}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
                    <HelpCircle className="size-3 shrink-0" aria-hidden />
                    {d.outcomeLabel}
                  </span>
                )}
                <span className="text-muted-foreground/50" aria-hidden>·</span>
                <span className="text-muted-foreground">
                  {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                </span>
                <span className="text-muted-foreground/50" aria-hidden>·</span>
                <span className="text-muted-foreground">
                  HTTP <span className="font-mono text-foreground/80">{d.statusLabel}</span>
                </span>
                <span className="text-muted-foreground/50" aria-hidden>·</span>
                <code className="font-mono text-foreground">{d.hostLabel}</code>
                <span className="text-muted-foreground/50" aria-hidden>·</span>
                <span className="text-muted-foreground">
                  {d.eventCount} event{d.eventCount === 1 ? '' : 's'}
                </span>
                <span
                  className="ml-auto text-muted-foreground/70"
                  title={formatAbsoluteFull(d.timestamp)}
                >
                  {formatRelative(d.timestamp)} ago
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

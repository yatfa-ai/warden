// Telemetry transparency panel — WARDEN-526. A READ-ONLY, in-product view of the
// telemetry verifiability engine shipped in WARDEN-508. It renders
// `describeCollection` (exactly what each consent tier collects) and
// `previewPayload` (the exact redacted + validated payload a sample event would
// transmit), so an opt-in — or considering-opt-in — user can confirm that what
// is sent matches what consent promised. This is the roadmap's "trust made
// verifiable" success measure, finally surfaced in the product.
//
// Boundaries (the clean part): the panel runs a HARDCODED SAMPLE event through
// two PURE renderer-side functions. No transport, no IPC, no /api/config
// preference, no receiver/endpoint, no new consent flag, no change to any
// consent invariant. It only DISPLAYS what the engine computes. Wired into the
// Telemetry section of SettingsPage (WARDEN-457) below the two consent toggles.
import { type ReactNode, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Check, ChevronDown, Minus, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SCHEMA_VERSION,
  describeCollection,
  previewPayload,
  type PreviewChange,
} from '@/lib/telemetry/transparency';
import type { ConsentTier } from '@/lib/telemetry/redact';
import { TelemetryTransmissionLog } from '@/components/TelemetryTransmissionLog';

/**
 * A representative `error` base event (valid per the base-event contract) whose
 * free-text `message` embeds one of EACH redactable kind — a file path, an
 * internal FQDN host, and a Bearer + sk-ant secret — plus a `chatName` to prove
 * the base-drop vs extended-retain identifier split. This is a fixture, NOT a
 * real event: it is never transmitted, only fed through the redaction engine
 * in-component so the user can inspect the exact output.
 */
const SAMPLE_ERROR_EVENT = {
  schemaVersion: SCHEMA_VERSION,
  type: 'error' as const,
  runtime: 'renderer' as const,
  timestamp: 1718000000000,
  // A non-identifying app RELEASE LABEL (identical for every user on a release),
  // attached to every emitted event so volume can be attributed to a release.
  // Included in the sample to SHOW it survives redaction — reinforcing, not
  // undermining, the trust model (it is neither content nor an identifier).
  appVersion: '0.1.19',
  name: 'TypeError',
  message:
    'Failed to load config from /home/user/secrets/config.json: connect to db.internal.corp.local failed (token=Bearer sk-ant-abc123def456ghi789jkl012mno345pqr678stu901)',
  frames: [{ function: 'loadConfig', file: 'config.js', line: 42 }],
  chatName: 'planner-main',
};

/** The two tiers a user can actively compare; `'off'` is not a preview choice. */
type PreviewTier = Exclude<ConsentTier, 'off'>;

interface Props {
  /** Whether the base consent toggle is on (drives the effective tier). */
  telemetryBaseEnabled: boolean;
  /** Whether the extended consent toggle is on (drives the effective tier). */
  telemetryExtendedEnabled: boolean;
}

/** Resolve the user's current effective tier from the persisted consent flags,
 *  mirroring the consent model in redact.ts / schema.ts. */
function effectiveTier(base: boolean, extended: boolean): ConsentTier {
  return base && extended ? 'extended' : base ? 'base' : 'off';
}

/** A small monospace field-name chip (used for event fields, identifiers, and
 *  hard-excluded content field lists). */
function FieldChip({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </code>
  );
}

/** One row in a tier-summary card: a check (collected) or dash (not collected) + label. */
function CollectsRow({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {ok ? (
        <Check className="size-3.5 shrink-0 text-green-500" aria-hidden />
      ) : (
        <Minus className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden />
      )}
      <span className={ok ? 'text-foreground' : undefined}>{children}</span>
    </div>
  );
}

/** Human label + Badge tone for a single enumerated redaction change. */
function changeBadge(change: PreviewChange): { label: string; variant: 'destructive' | 'secondary' } {
  switch (change.kind) {
    case 'dropped-content':
      return { label: 'content dropped', variant: 'destructive' };
    case 'dropped-identifier':
      return { label: 'name dropped', variant: 'destructive' };
    case 'retained-identifier':
      return { label: 'name retained', variant: 'secondary' };
    case 'redacted': {
      const cat = change.category ?? 'redacted';
      return {
        label: change.count && change.count > 1 ? `redacted · ${cat} ×${change.count}` : `redacted · ${cat}`,
        variant: 'destructive',
      };
    }
  }
}

export function TelemetryTransparency({ telemetryBaseEnabled, telemetryExtendedEnabled }: Props) {
  // The preview tier tracks the user's current effective tier until they pick
  // one manually (so an opt-in user sees their tier by default), then sticks —
  // letting them compare the SAME sample event across base vs extended. A user
  // who has telemetry off still sees a useful preview, defaulting to `base`.
  const current = effectiveTier(telemetryBaseEnabled, telemetryExtendedEnabled);
  const [override, setOverride] = useState<PreviewTier | null>(null);
  const previewTier: PreviewTier = override ?? (current === 'extended' ? 'extended' : 'base');

  const [showPayload, setShowPayload] = useState(true);
  const [showSample, setShowSample] = useState(false);

  // The catalog is deterministic per tier; compute once. Both tiers share the
  // same base-event types and hard-excluded content list — the ONLY difference
  // is whether chat/session-name identifiers are collected (extended only).
  const baseCatalog = useMemo(() => describeCollection('base'), []);
  const extendedCatalog = useMemo(() => describeCollection('extended'), []);
  const preview = useMemo(() => previewPayload(SAMPLE_ERROR_EVENT, previewTier), [previewTier]);

  // Group the redaction substitutions by category for the one-line summary
  // (e.g. "1 path, 1 host, 1 secret redacted · 1 name dropped").
  const redactedByCat = new Map<string, number>();
  let droppedContent = 0;
  let droppedNames = 0;
  let retainedNames = 0;
  for (const c of preview.changes) {
    if (c.kind === 'redacted') redactedByCat.set(c.category ?? 'redacted', (redactedByCat.get(c.category ?? 'redacted') ?? 0) + (c.count ?? 1));
    else if (c.kind === 'dropped-content') droppedContent++;
    else if (c.kind === 'dropped-identifier') droppedNames++;
    else if (c.kind === 'retained-identifier') retainedNames++;
  }
  const summaryParts: string[] = [];
  for (const [cat, n] of redactedByCat) summaryParts.push(`${n} ${cat}`);
  const redactedSummary = summaryParts.length ? `${summaryParts.join(', ')} redacted` : 'nothing redacted';
  const nameSummary =
    previewTier === 'extended'
      ? retainedNames > 0
        ? `${retainedNames} name retained`
        : 'no names retained'
      : droppedNames > 0
        ? `${droppedNames} name dropped`
        : 'no names dropped';

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-medium text-foreground">What telemetry sends</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        A live, local preview of exactly what each consent tier collects and the precise
        redacted payload a sample event would transmit — generated by the same redaction engine
        your telemetry uses. Nothing here is sent; this is a read-only inspection.
      </p>

      {/* 1 — Per-tier collection catalog (describeCollection). */}
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold text-foreground">What each tier collects</h4>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <TierSummaryCard
            title="Base tier"
            isCurrent={current === 'base'}
            collectsBase={baseCatalog.collectsBaseEvents}
            collectsNames={baseCatalog.collectsIdentifiers}
          />
          <TierSummaryCard
            title="Extended tier"
            subtitle="requires base"
            isCurrent={current === 'extended'}
            collectsBase={extendedCatalog.collectsBaseEvents}
            collectsNames={extendedCatalog.collectsIdentifiers}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            Anonymous event types &amp; structural fields (base &amp; extended):
          </span>
          <div className="flex flex-col gap-1">
            {baseCatalog.eventTypes.map((et) => (
              <div key={et.type} className="flex flex-wrap items-center gap-1.5">
                <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] font-semibold text-foreground ring-1 ring-border">
                  {et.type}
                </code>
                <span className="text-[11px] text-muted-foreground/70">→</span>
                {et.fields.map((f) => (
                  <FieldChip key={f}>{f}</FieldChip>
                ))}
              </div>
            ))}
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">
            A trailing <code className="font-mono">?</code> marks an optional field.{' '}
            <code className="font-mono">appVersion?</code> is a non-identifying app release label (the version of warden
            you installed) — not content, not a chat/session identifier — carried only so a maintainer can attribute event
            volume to a release. It is sent on every event when the version is readable.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            Chat &amp; session-name identifiers — retained <em className="not-italic font-semibold">only</em> at
            extended; dropped at base:
          </span>
          <div className="flex flex-wrap gap-1.5">
            {extendedCatalog.identifierFields.length ? (
              extendedCatalog.identifierFields.map((f) => <FieldChip key={f}>{f}</FieldChip>)
            ) : (
              <span className="text-[11px] text-muted-foreground/60">none</span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            Never collected — content / prompt fields hard-excluded at every tier:
          </span>
          <div className="flex flex-wrap gap-1.5">
            {baseCatalog.hardExcludedContent.map((f) => (
              <FieldChip key={f}>{f}</FieldChip>
            ))}
          </div>
        </div>
      </div>

      <div className="h-px bg-border" role="separator" />

      {/* 2 — Live redaction preview (previewPayload). */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-foreground">Sample event preview</h4>
          {/* Segmented base/extended toggle — compare the same event across tiers. */}
          <div
            className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
            role="group"
            aria-label="Preview consent tier"
          >
            {(['base', 'extended'] as const).map((t) => (
              <Button
                key={t}
                size="xs"
                variant={previewTier === t ? 'secondary' : 'ghost'}
                aria-pressed={previewTier === t}
                onClick={() => setOverride(t)}
                className="gap-1"
              >
                {t === 'base' ? 'Base' : 'Extended'}
                {current === t && (
                  <Badge variant="outline" className="h-3.5 px-1 text-[9px] uppercase tracking-wide">
                    current
                  </Badge>
                )}
              </Button>
            ))}
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Previewing the sample event as the <span className="font-medium text-foreground">{previewTier}</span> tier
          would transmit it. Toggle tiers to see <code className="font-mono">chatName</code> drop at base and
          survive (scrubbed) at extended.
        </p>

        {/* Validity + redaction summary, always visible. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {preview.valid ? (
            <Badge variant="outline" className="gap-1 border-green-500/40 text-green-600 dark:text-green-400">
              <Check className="size-3" aria-hidden /> schema-valid
            </Badge>
          ) : (
            <Badge variant="destructive">schema-invalid</Badge>
          )}
          <Badge variant="secondary">{redactedSummary}</Badge>
          {droppedContent > 0 && <Badge variant="outline">{droppedContent} content field dropped</Badge>}
          <Badge variant={previewTier === 'extended' ? 'secondary' : 'outline'}>{nameSummary}</Badge>
        </div>

        {/* Enumerated redaction diff — scannable, always visible. */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            What redaction did ({preview.changes.length}):
          </span>
          <ul className="flex flex-col gap-1">
            {preview.changes.map((c, i) => {
              const cb = changeBadge(c);
              return (
                <li key={`${c.path}-${c.kind}-${i}`} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <Badge variant={cb.variant} className="h-4 px-1.5 text-[10px]">
                    {cb.label}
                  </Badge>
                  <code className="font-mono text-foreground">{c.path}</code>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Exact transmitted payload — verbose, behind a disclosure. */}
        <div className="flex flex-col gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowPayload((v) => !v)}
            aria-expanded={showPayload}
            className="w-fit gap-1 text-[11px] text-muted-foreground"
          >
            <ChevronDown className={cn('size-3.5 transition-transform', showPayload ? '' : '-rotate-90')} aria-hidden />
            {showPayload ? 'Hide' : 'Show'} exact transmitted payload
          </Button>
          {showPayload && (
            <pre className="max-h-72 overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-[11px] leading-relaxed text-foreground">
              {JSON.stringify(preview.payload, null, 2)}
            </pre>
          )}
        </div>

        {/* Original sample (what we fed in) — secondary, behind a disclosure. */}
        <div className="flex flex-col gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowSample((v) => !v)}
            aria-expanded={showSample}
            className="w-fit gap-1 text-[11px] text-muted-foreground"
          >
            <ChevronDown className={cn('size-3.5 transition-transform', showSample ? '' : '-rotate-90')} aria-hidden />
            {showSample ? 'Hide' : 'Show'} original sample event (input)
          </Button>
          {showSample && (
            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {JSON.stringify(SAMPLE_ERROR_EVENT, null, 2)}
            </pre>
          )}
        </div>
      </div>

      <div className="h-px bg-border" role="separator" />

      {/* 3 — ACTUAL send outcomes (WARDEN-668). The promise (describeCollection)
          and the preview (previewPayload) are the first two legs; this is what
          really landed on the wire — a read-only, live, session-scoped view of
          the same ring the pipeline records on every real send. Read from the
          telemetry:transmission-log IPC bridge; degrades to an honest "no sends
          this session yet" empty state when the bridge is absent or the ring is
          empty (e.g. telemetry off). */}
      <TelemetryTransmissionLog />
    </div>
  );
}

/** A compact tier-summary card: which categories a tier collects. */
function TierSummaryCard({
  title,
  subtitle,
  isCurrent,
  collectsBase,
  collectsNames,
}: {
  title: string;
  subtitle?: string;
  isCurrent: boolean;
  collectsBase: boolean;
  collectsNames: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-foreground">{title}</span>
        {subtitle && <span className="text-[10px] text-muted-foreground/70">({subtitle})</span>}
        {isCurrent && (
          <Badge variant="secondary" className="ml-auto h-4 px-1.5 text-[10px]">
            your tier
          </Badge>
        )}
      </div>
      <CollectsRow ok={collectsBase}>Anonymous error, crash &amp; freeze events</CollectsRow>
      <CollectsRow ok={collectsNames}>Chat &amp; session names</CollectsRow>
    </div>
  );
}

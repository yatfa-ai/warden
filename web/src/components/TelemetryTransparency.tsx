// Telemetry transparency panel — WARDEN-526, reworked onto PER-CATEGORY consent
// by WARDEN-1116. A READ-ONLY, in-product view of the telemetry verifiability
// engine. It renders `describeCollection` (exactly what each consent CATEGORY
// collects, and whether the user has it on) and `previewPayload` (the exact
// redacted + validated payload a sample event would transmit under the user's
// actual combination), so an opt-in — or considering-opt-in — user can confirm
// that what is sent matches what consent promised.
//
// It tells the truth for ANY combination, including ones the old three-value tier
// could not express: a decorating category on with nothing collecting is shown as
// enabled-but-sending-nothing rather than quietly implying names are transmitted.
//
// Boundaries (the clean part): the panel runs a HARDCODED SAMPLE event through
// PURE renderer-side functions. No transport, no IPC, no /api/config write, no
// receiver/endpoint, no new consent flag, no change to any consent invariant. It
// only DISPLAYS what the engine computes.
import { type ReactNode, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Check, ChevronDown, Minus, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SCHEMA_VERSION,
  describeCollection,
  previewPayload,
  type CategoryCollection,
  type PreviewChange,
} from '@/lib/telemetry/transparency';
import {
  TELEMETRY_CATEGORIES,
  withCategory,
  type TelemetryConsent,
} from '@/lib/telemetry/consent';
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
  // A non-identifying OS LABEL (process.platform — darwin/win32/linux; identical
  // for millions of users on an OS), attached to every emitted event so volume
  // can be attributed to an OS. Same trust posture as appVersion: neither content
  // nor an identifier, and redaction is a no-op for it.
  platform: 'darwin',
  name: 'TypeError',
  message:
    'Failed to load config from /home/user/secrets/config.json: connect to db.internal.corp.local failed (token=Bearer sk-ant-abc123def456ghi789jkl012mno345pqr678stu901)',
  frames: [{ function: 'loadConfig', file: 'config.js', line: 42 }],
  chatName: 'planner-main',
};

interface Props {
  /** The user's live per-category consent (already resolved by the caller through
   *  the single consent authority — this panel never re-derives it). */
  consent: TelemetryConsent;
}

/**
 * Every event type ANY category can produce, with its anonymous structural
 * fields. Derived from an all-categories-on catalog so the structural disclosure
 * is COMPLETE regardless of what the user currently has enabled — the per-category
 * cards above say which of them actually apply to them. Computed once at module
 * load (the registry is static).
 */
const ALL_EVENT_TYPES = describeCollection(
  Object.fromEntries(TELEMETRY_CATEGORIES.map((c) => [c.id, true])),
).eventTypes;

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

export function TelemetryTransparency({ consent }: Props) {
  // The preview consent tracks the user's ACTUAL consent until they explore a
  // different combination, then sticks — letting them compare the SAME sample
  // event across combinations without touching their real settings. A user with
  // telemetry off still sees a useful preview; `null` means "follow my consent".
  const [override, setOverride] = useState<TelemetryConsent | null>(null);
  const previewConsent = override ?? consent;

  const [showPayload, setShowPayload] = useState(true);
  const [showSample, setShowSample] = useState(false);

  // The catalog of what the user's ACTUAL consent collects (drives the category
  // cards), and the catalog for whatever combination is being previewed.
  const catalog = useMemo(() => describeCollection(consent), [consent]);
  const preview = useMemo(() => previewPayload(SAMPLE_ERROR_EVENT, previewConsent), [previewConsent]);
  // Human labels for whatever combination is being previewed.
  const enabledPreviewLabels = TELEMETRY_CATEGORIES
    .filter((c) => previewConsent[c.id] === true)
    .map((c) => c.label);

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
    retainedNames > 0
      ? `${retainedNames} name retained`
      : droppedNames > 0
        ? `${droppedNames} name dropped`
        : 'no names in this event';

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-medium text-foreground">What telemetry sends</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        A live, local preview of exactly what each consent category collects and the precise
        redacted payload a sample event would transmit — generated by the same redaction engine
        your telemetry uses. Nothing here is sent; this is a read-only inspection.
      </p>

      {/* 1 — Per-CATEGORY collection catalog (describeCollection). Rendered from
          the catalog, so a new category appears here with no edit. */}
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold text-foreground">What each category collects</h4>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {catalog.categories.map((cat) => (
            <CategorySummaryCard key={cat.id} category={cat} />
          ))}
        </div>

        {/* The honest bottom line for the user's ACTUAL combination. */}
        <p
          className="text-[11px] text-muted-foreground"
          data-telemetry-collects={catalog.collectsAnything ? 'yes' : 'no'}
          role="status"
        >
          {catalog.collectsAnything ? (
            <>
              With your current selection, warden collects{' '}
              <span className="font-medium text-foreground">
                {catalog.eventTypes.map((e) => e.type).join(', ')}
              </span>
              {catalog.retainedFields.length ? (
                <>
                  , and retains{' '}
                  <span className="font-medium text-foreground">
                    {catalog.retainedFields.join(', ')}
                  </span>
                </>
              ) : (
                ', with no identifiers'
              )}
              .
            </>
          ) : (
            <>
              With your current selection, <span className="font-medium text-foreground">nothing is collected and nothing is sent</span>
              {catalog.categories.some((c) => c.inert)
                ? ' — the categories you have on only add fields to events other categories produce, and none of those is on.'
                : '.'}
            </>
          )}
        </p>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            Anonymous event types &amp; structural fields:
          </span>
          <div className="flex flex-col gap-1">
            {ALL_EVENT_TYPES.map((et) => (
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
            volume to a release.{' '}
            <code className="font-mono">platform?</code> is its sibling: a non-identifying OS label (one of{' '}
            <code className="font-mono">darwin</code>/<code className="font-mono">win32</code>/<code className="font-mono">linux</code>) carried so a maintainer can tell whether a spike is
            Mac / Windows / Linux-specific. Both are sent on every event when the value is readable.
          </p>
        </div>

        {catalog.categories
          .filter((cat) => cat.fields.length > 0)
          .map((cat) => (
            <div key={cat.id} className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                Fields gated by <span className="font-semibold text-foreground">{cat.label}</span> —
                retained <em className="not-italic font-semibold">only</em> while that category is on;
                dropped otherwise:
              </span>
              <div className="flex flex-wrap gap-1.5">
                {cat.fields.map((f) => (
                  <FieldChip key={f}>{f}</FieldChip>
                ))}
              </div>
            </div>
          ))}

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            Never collected — content / prompt fields hard-excluded under every combination:
          </span>
          <div className="flex flex-wrap gap-1.5">
            {catalog.hardExcludedContent.map((f) => (
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
          {/* Per-CATEGORY preview switches — explore ANY combination against the
              same sample event, including combinations the old tier could not
              express. These change only the preview; the user's real consent is
              untouched. */}
          <div
            className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
            role="group"
            aria-label="Preview consent categories"
          >
            {catalog.categories.map((cat) => {
              const on = previewConsent[cat.id] === true;
              return (
                <Button
                  key={cat.id}
                  size="xs"
                  variant={on ? 'secondary' : 'ghost'}
                  aria-pressed={on}
                  onClick={() => setOverride(withCategory(previewConsent, cat.id, !on))}
                  className="gap-1"
                >
                  {cat.label}
                </Button>
              );
            })}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setOverride(null)}
              disabled={override === null}
              className="gap-1"
            >
              Reset to mine
            </Button>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Previewing the sample event under{' '}
          <span className="font-medium text-foreground">
            {enabledPreviewLabels.length ? enabledPreviewLabels.join(' + ') : 'no categories'}
          </span>
          . Toggle categories to see <code className="font-mono">chatName</code> drop when the name
          category is off and survive (scrubbed) when it is on — and to see that with nothing
          collecting, nothing is transmitted at all.
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
          <Badge variant={retainedNames > 0 ? 'secondary' : 'outline'}>{nameSummary}</Badge>
          {/* The gate the schema check does NOT cover: a valid payload is still
              only sent when a collecting category is on. */}
          <Badge
            variant={preview.transmitted ? 'secondary' : 'outline'}
            data-telemetry-preview-transmitted={preview.transmitted ? 'yes' : 'no'}
          >
            {preview.transmitted ? 'would be sent' : 'not sent — nothing is being collected'}
          </Badge>
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

/** A compact per-CATEGORY card: what this category collects and whether it is on. */
function CategorySummaryCard({ category }: { category: CategoryCollection }) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2.5"
      data-telemetry-category={category.id}
      data-telemetry-category-enabled={category.enabled ? 'yes' : 'no'}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-foreground">{category.label}</span>
        <Badge variant={category.enabled ? 'secondary' : 'outline'} className="ml-auto h-4 px-1.5 text-[10px]">
          {category.enabled ? 'on' : 'off'}
        </Badge>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{category.summary}</p>
      {category.eventTypes.map((et) => (
        <CollectsRow key={et.type} ok={category.enabled}>
          <code className="font-mono">{et.type}</code> events
        </CollectsRow>
      ))}
      {category.fields.map((f) => (
        <CollectsRow key={f} ok={category.enabled && !category.inert}>
          <code className="font-mono">{f}</code>
        </CollectsRow>
      ))}
      {category.inert && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          On, but inert: it only decorates events other categories produce, and none of those is on
          — so nothing is sent.
        </p>
      )}
    </div>
  );
}

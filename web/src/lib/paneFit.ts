// paneFit — the pure, React-free core of the terminal pane's fit→resize
// coalescer (WARDEN-920).
//
// THE BUG THIS EXISTS TO KILL
// ---------------------------
// PaneTile drove xterm's FitAddon straight from a ResizeObserver callback:
//
//     const doFit = () => { try { fit.fit(); } catch {} };
//     const ro = new ResizeObserver(doFit); ro.observe(wrapRef.current!);
//     term.onResize(() => streamApi.send({ type: 'resize', id, cols, rows }));
//
// Two un-coalesced paths, one storm. Any container reflow — above all a
// WORKSPACE SWITCH, where WARDEN-372's unmount model means each PaneTile
// REMOUNTS and a brand-new Terminal is open()ed into a container that is still
// settling under the grid's `transition-all duration-200` — walks the container
// through a run of intermediate dimensions. Each intermediate fired `fit()`
// synchronously, each fit that changed cols/rows fired `onResize`, and each
// onResize shipped a `{type:'resize'}` to the PTY. tmux + the shell then redrew
// the prompt once per transient → the input line visibly hops, glyphs mis-align,
// and the pane feels laggy until a hard reload. The same path is walked by
// sidebar collapse, window resize, gutter drag (WARDEN-660) and maximize/restore.
//
// Worse, the guard was not a guard. `@xterm/addon-fit@0.11`'s proposeDimensions()
// does NOT fail on a zero-size container — it returns a DEGENERATE SUCCESS:
//
//     cols: Math.max(MINIMUM_COLS /* 2 */, Math.floor(availableWidth  / cellW)),
//     rows: Math.max(MINIMUM_ROWS /* 1 */, Math.floor(availableHeight / cellH)),
//
// so a not-yet-laid-out container fits the terminal to 2x1 and announces 2x1 to
// the PTY. The `try/catch {}` never sees a throw because nothing throws. Only an
// explicit container-dimension check stops it (see {@link isFittableRect}).
//
// THE CONTRACT
// ------------
// {@link createFitScheduler} splits the two halves of the storm and treats them
// differently, because they have different liveness requirements:
//
//   - THE FIT (what the user SEES) is coalesced to at most one per animation
//     frame. Still live — a gutter drag reflows every frame, so WARDEN-660 keeps
//     feeling responsive — but N observer callbacks in one frame collapse to one
//     fit instead of N.
//   - THE ANNOUNCE (what the PTY LEARNS) is trailing-debounced by
//     {@link FIT_SETTLE_MS} and de-duplicated against the last announced size, so
//     tmux is told the SETTLED dimensions exactly once instead of every transient
//     step. This is the half that stops the prompt from hopping; coalescing the
//     fit alone would not have.
//
// Split out from the component — mirroring src/lib/visiblePoller.ts vs
// useVisiblePoller.ts, and src/lib/paneAttach.ts — because the repo's web/ test
// harness is `node --test` with no jsdom/vitest (WARDEN-130), so the only way to
// pin timing behavior in a regression test is to make it a pure module driven
// through an injected env. paneFit.test.mjs loads THIS file and drives the
// workspace-switch storm through it.
//
// THE RESIDUAL THIS MODULE LATER HAD TO KILL (WARDEN-1052)
// -------------------------------------------------------
// Coalescing closed the storm of intermediate resizes. What it did NOT close is
// the FINAL state after a relayout that BOUNCES — a pane whose height changes
// during the transition and lands back on the size it started from:
// maximize→restore, a sidebar/Observer panel opened and closed, the in-pane
// search bar toggled, a window resize dragged back, entering/leaving OS
// full-screen. The user sees the tmux status line and the prompt stranded in the
// upper third of the pane with a dead band of blank rows under them, and only a
// manual maximize/restore toggle repairs it.
//
// The two halves of the coalescer come apart on that bounce:
//
//   - THE FIT is live, so xterm is really resized to each intermediate geometry.
//     xterm's resize is DESTRUCTIVE on the alternate screen buffer (which is what
//     tmux runs in): shrinking to 9 rows drops the rows below, and growing back to
//     55 appends BLANK rows at the bottom. The pre-bounce picture is gone from
//     xterm's own buffer and only tmux can repaint it.
//   - THE ANNOUNCE is de-duplicated, and the settled size is the size the PTY was
//     already told. `shouldAnnounceSize` says "stay silent" — so tmux is never
//     given a reason to redraw, and the mangled buffer stays on screen forever.
//
// That is exactly the measured evidence on the ticket: the tmux server reports
// the CORRECT row count (its own screen is intact), the CSS geometry is correct,
// xterm's row count is correct — only the pixels are a paint for a size the pane
// no longer has. The de-dup record was never a record of "the user received this
// paint"; it is only a record of "the PTY was told this number".
//
// The fix keeps the de-dup (it is what stops the prompt hopping) and adds the
// missing half: a settle that lands back on the already-announced geometry, AFTER
// the terminal genuinely resized at least once, asks the PTY for a REPAINT
// instead of staying silent — see {@link repaintNudgeSize} and the `settle`
// branch in {@link createFitScheduler}.

/**
 * Minimum container extent, in CSS pixels, for a fit to be considered
 * meaningful in either axis.
 *
 * A container below this is mid-layout (freshly remounted pane, collapsed
 * track, display transition) rather than a real pane the user is looking at,
 * and fitting against it produces the degenerate 2x1 geometry described above.
 * 24px is under two character cells at the smallest supported font size (8px),
 * so it can never reject a container a user could actually read text in — it
 * only rejects "not laid out yet".
 */
export const MIN_FIT_PX = 24;

/**
 * Quiet period, in ms, after the last terminal size change before the settled
 * dimensions are announced to the PTY.
 *
 * Sized against the grid's `transition-all duration-200` (PaneGrid.tsx): the
 * announce lands shortly after the layout transition finishes, so tmux receives
 * one resize for the final geometry instead of one per transition frame. During
 * a gutter drag the announce simply waits for the user to stop moving; the
 * on-screen fit is NOT delayed by this (see the module note above), so the drag
 * itself stays live.
 */
export const FIT_SETTLE_MS = 120;

/**
 * Delay before re-attempting a fit that could not run — the container was not
 * measurable yet ({@link isFittableRect} false), or the renderer had no cell
 * metrics (webfont still loading, so FitAddon.proposeDimensions() returns
 * undefined and fit() is a silent no-op).
 *
 * A ResizeObserver does NOT re-fire when only the FONT finishes loading, so
 * without this retry a pane that mounted before its metrics were ready would
 * keep xterm's 80x24 default until the next unrelated reflow. Bounded by
 * {@link FIT_MAX_RETRIES} so a container that is legitimately zero-size forever
 * costs a fixed, finite number of wake-ups rather than an endless timer loop.
 */
export const FIT_RETRY_MS = 50;

/** Maximum consecutive retries of a fit that could not run ({@link FIT_RETRY_MS}). */
export const FIT_MAX_RETRIES = 10;

/**
 * Gap, in ms, between the two halves of the repaint nudge (WARDEN-1052).
 *
 * The nudge only works if the far end observes TWO DISTINCT sizes. The size does
 * not travel as a message: it is an ioctl on the PTY master, delivered to the
 * attached process as SIGWINCH, and every hop on the way to tmux (node-pty →
 * `ssh` → sshd → `docker exec -it` → the tmux client) re-reads the CURRENT tty
 * size when it handles that signal rather than queueing each value. Two ioctls
 * inside one event-loop turn therefore collapse into a single "size is still
 * what it was" wake-up and nothing redraws at all. 80ms is comfortably more than
 * a signal round-trip on any of those transports while staying under the
 * threshold where the intervening one-row-short paint reads as a flicker rather
 * than as the repair landing.
 */
export const REPAINT_NUDGE_MS = 80;

/**
 * The server's lower clamp on announced rows (`Math.max(6, …)` in the `resize`
 * handler, src/server.js). A nudge below it is silently flattened back to the
 * size we are trying to nudge away from — i.e. no size change, no redraw — so
 * {@link repaintNudgeSize} nudges the other way for a pane this short.
 */
export const MIN_PTY_ROWS = 6;

/** The measured extent of the pane's terminal container, in CSS pixels. */
export interface ContainerRect {
  width: number;
  height: number;
}

/** A terminal geometry in character cells. */
export interface TermSize {
  cols: number;
  rows: number;
}

/**
 * Is this container worth fitting against?
 *
 * The whole point of the check: FitAddon does not reject a zero/tiny container,
 * it clamps to 2x1 and reports success, so the caller must reject it. Rejects a
 * missing measurement (an unmounted/never-attached ref), a non-finite extent
 * (NaN from a computed style that had no value), and anything under
 * {@link MIN_FIT_PX} in EITHER axis — a pane 0px tall is as unfittable as one
 * 0px wide.
 */
export function isFittableRect(rect: ContainerRect | null | undefined): boolean {
  if (!rect) return false;
  const { width, height } = rect;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return width >= MIN_FIT_PX && height >= MIN_FIT_PX;
}

/**
 * Should this settled size be announced to the PTY?
 *
 * True only for a real, finite, positive geometry that DIFFERS from what the PTY
 * was last told. The de-duplication is what makes a workspace switch quiet: a
 * remounted pane that settles back to the dimensions its PTY already has sends
 * nothing at all, instead of a resize that would make tmux redraw the prompt for
 * no reason.
 */
export function shouldAnnounceSize(prev: TermSize | null | undefined, next: TermSize): boolean {
  if (!Number.isFinite(next.cols) || !Number.isFinite(next.rows)) return false;
  if (next.cols < 1 || next.rows < 1) return false;
  if (!prev) return true;
  return prev.cols !== next.cols || prev.rows !== next.rows;
}

/**
 * The transient geometry used to force tmux to repaint a pane whose settled size
 * the PTY already knows (WARDEN-1052).
 *
 * Nudging is the programmatic form of the manual maximize/restore toggle users
 * currently use to repair one of these panes: make the terminal's size change,
 * so tmux redraws the client in full, then put it back.
 *
 * SHRINK, never grow. The nudge changes only what the PTY is TOLD — xterm itself
 * stays at `size`. Announcing one row FEWER means tmux paints a screen one row
 * shorter than the pane for {@link REPAINT_NUDGE_MS}: the bottom row is briefly
 * blank, and nothing else moves. Announcing one row MORE would make tmux paint
 * one row MORE than xterm can hold, which scrolls the pane by a line and shifts
 * every row of the repaired picture — a visible glitch, and on a plain shell a
 * line pushed into scrollback. The only pane that has to grow instead is one
 * already at {@link MIN_PTY_ROWS}, where a shrink would be clamped away
 * server-side and buy no redraw at all.
 */
export function repaintNudgeSize(size: TermSize): TermSize {
  return {
    cols: size.cols,
    rows: size.rows > MIN_PTY_ROWS ? size.rows - 1 : size.rows + 1,
  };
}

/**
 * The timer/frame surface the scheduler drives, injected so the coalescing
 * contract is unit-testable without a DOM (paneFit.test.mjs passes fakes it
 * steps by hand; the component passes the real window bindings).
 */
export interface FitSchedulerEnv {
  requestAnimationFrame: (cb: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
}

export interface FitSchedulerOptions {
  /** Measure the terminal container. Return null when there is nothing to measure. */
  measure: () => ContainerRect | null;
  /**
   * Apply the fit. Returns whether it actually ran: false means the renderer was
   * not ready (no cell metrics yet), which schedules a bounded retry.
   */
  fit: () => boolean;
  /** Read the terminal's CURRENT geometry (at announce time, not at schedule time). */
  currentSize: () => TermSize;
  /** Tell the PTY about the settled geometry. */
  announce: (size: TermSize) => void;
  /** Override the trailing-announce quiet period (defaults to {@link FIT_SETTLE_MS}). */
  settleMs?: number;
}

export interface FitScheduler {
  /**
   * Request a fit. Any number of calls within one animation frame collapse into
   * a single fit — this is the coalescing half of the fix. Call from the
   * ResizeObserver and from every option change that alters cell metrics
   * (font size / family, theme).
   */
  request: () => void;
  /**
   * Fit RIGHT NOW, synchronously, bypassing the frame coalescer. Used only by
   * the attach effect, which must read the terminal's geometry in the same tick
   * to put cols/rows in its `attach` message. Honors the same container guard,
   * so a not-yet-laid-out pane is left at its defaults rather than fitted to 2x1.
   */
  fitNow: () => void;
  /**
   * Record a terminal size change (wire to `term.onResize`). Arms/re-arms the
   * trailing announce; the PTY hears only the size that survives the quiet
   * period.
   */
  noteResize: () => void;
  /**
   * Record a size the PTY already knows through another channel — specifically
   * the cols/rows carried by the `attach` message. Suppresses the redundant
   * resize that would otherwise follow the first settle.
   *
   * This is also an assertion that the PTY has just PAINTED that geometry (the
   * server resizes the PTY and tmux redraws as part of the attach), so it clears
   * any settle armed by the fits that led up to the attach — without that, the
   * first settle would see "same size as announced" and read the attach's own
   * fit as a stale-paint bounce, nudging a pane that is already correct
   * (WARDEN-1052).
   */
  markAnnounced: (size: TermSize) => void;
  /** Cancel every pending frame/timer. No trailing announce fires after this. */
  dispose: () => void;
}

/**
 * Build the fit→resize coalescer for one pane. See the module header for the
 * contract and why the fit and the announce are coalesced differently.
 */
export function createFitScheduler(opts: FitSchedulerOptions, env: FitSchedulerEnv): FitScheduler {
  const settleMs = opts.settleMs ?? FIT_SETTLE_MS;

  let frame: number | null = null;      // pending animation frame (the fit coalescer)
  let retryTimer: number | null = null; // pending retry of a fit that could not run
  let settleTimer: number | null = null;// pending trailing announce
  let nudgeTimer: number | null = null; // pending restore half of a repaint nudge
  let retries = 0;
  let lastAnnounced: TermSize | null = null;
  let disposed = false;

  const clearRetry = () => {
    if (retryTimer !== null) { env.clearTimeout(retryTimer); retryTimer = null; }
  };

  const clearNudge = () => {
    if (nudgeTimer !== null) { env.clearTimeout(nudgeTimer); nudgeTimer = null; }
  };

  const clearSettle = () => {
    if (settleTimer !== null) { env.clearTimeout(settleTimer); settleTimer = null; }
  };

  // Announce a size and record it as what the PTY was last told. `lastAnnounced`
  // tracks the last value SENT (including the transient half of a nudge), so a
  // settle that lands while a nudge is in flight still reads as a real change and
  // announces the true geometry.
  const announceSize = (size: TermSize) => {
    lastAnnounced = { cols: size.cols, rows: size.rows };
    opts.announce(lastAnnounced);
  };

  // WARDEN-1052: the pane settled back onto the geometry the PTY already has, but
  // xterm was really resized on the way there and its alternate-screen buffer no
  // longer holds the picture tmux painted. Nothing about the SIZE needs changing
  // — a REPAINT does — and the only lever this transport has on tmux is the size
  // itself, so drive one: announce a one-row-different geometry, then the true
  // one. tmux redraws the client in full on each, and the second redraw is the
  // correct picture at the correct size. See {@link repaintNudgeSize} for why the
  // transient is a shrink and {@link REPAINT_NUDGE_MS} for why the two announces
  // cannot share a tick.
  const requestRepaint = (size: TermSize) => {
    announceSize(repaintNudgeSize(size));
    nudgeTimer = env.setTimeout(() => {
      nudgeTimer = null;
      if (disposed) return;
      announceSize(size);
    }, REPAINT_NUDGE_MS);
  };

  // Run the guarded fit. Returns whether it ran, so the frame body can decide
  // between "done" and "retry shortly".
  const runFit = (): boolean => {
    if (!isFittableRect(opts.measure())) return false;
    return opts.fit();
  };

  const scheduleRetry = () => {
    if (disposed || retryTimer !== null || retries >= FIT_MAX_RETRIES) return;
    retries += 1;
    retryTimer = env.setTimeout(() => { retryTimer = null; request(); }, FIT_RETRY_MS);
  };

  const request = () => {
    if (disposed || frame !== null) return; // already coalescing into this frame
    frame = env.requestAnimationFrame(() => {
      frame = null;
      if (disposed) return;
      if (runFit()) { retries = 0; clearRetry(); }
      else scheduleRetry();
    });
  };

  const fitNow = () => {
    if (disposed) return;
    if (runFit()) { retries = 0; clearRetry(); }
    else scheduleRetry();
  };

  const noteResize = () => {
    if (disposed) return;
    // The terminal moved again, so a nudge waiting to restore "the size we are
    // settled at" is talking about a size the pane no longer has. Drop it: this
    // resize will settle into an announce of its own, and because `lastAnnounced`
    // still holds the nudge's transient geometry that announce is never de-duped
    // away — the pane gets its repaint either way, without a stale hop through
    // the old size on the way there.
    clearNudge();
    if (settleTimer !== null) env.clearTimeout(settleTimer);
    settleTimer = env.setTimeout(() => {
      settleTimer = null;
      if (disposed) return;
      const size = opts.currentSize();
      // The settle timer is armed ONLY from term.onResize, which fires only on a
      // real cols/rows change — so reaching here means the terminal was resized
      // at least once since the PTY was last told anything. Either the geometry
      // moved (announce it; the resize is itself a full redraw) or it bounced and
      // came back (announce nothing, but the picture on screen is a paint for a
      // size the pane no longer has → repaint it). WARDEN-1052: the second branch
      // used to be a silent `return`, which is what stranded the tmux status line
      // in the upper third of a pane with dead space under it.
      if (shouldAnnounceSize(lastAnnounced, size)) { announceSize(size); return; }
      if (!shouldAnnounceSize(null, size)) return; // degenerate geometry — nothing worth painting
      requestRepaint(size);
    }, settleMs);
  };

  const markAnnounced = (size: TermSize) => {
    lastAnnounced = { cols: size.cols, rows: size.rows };
    // The caller is asserting a fresh PAINT at this geometry, not just that the
    // number was delivered — so the fits that produced it are accounted for and
    // any settle/nudge they armed is stale. Leaving the settle armed would make
    // the attach's own fit look like a bounce and nudge a correct pane.
    clearSettle();
    clearNudge();
  };

  const dispose = () => {
    disposed = true;
    if (frame !== null) { env.cancelAnimationFrame(frame); frame = null; }
    clearSettle();
    clearNudge();
    clearRetry();
  };

  return { request, fitNow, noteResize, markAnnounced, dispose };
}

/**
 * The real browser timer/frame surface. Kept here (not in the component) so the
 * component holds no timing logic at all and the only untested line is this
 * binding table — the same split visiblePoller.ts/useVisiblePoller.ts uses.
 */
export const browserFitEnv: FitSchedulerEnv = {
  requestAnimationFrame: (cb) => window.requestAnimationFrame(cb),
  cancelAnimationFrame: (h) => window.cancelAnimationFrame(h),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h),
};

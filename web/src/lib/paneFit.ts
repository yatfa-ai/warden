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
  let retries = 0;
  let lastAnnounced: TermSize | null = null;
  let disposed = false;

  const clearRetry = () => {
    if (retryTimer !== null) { env.clearTimeout(retryTimer); retryTimer = null; }
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
    if (settleTimer !== null) env.clearTimeout(settleTimer);
    settleTimer = env.setTimeout(() => {
      settleTimer = null;
      if (disposed) return;
      const size = opts.currentSize();
      if (!shouldAnnounceSize(lastAnnounced, size)) return;
      lastAnnounced = { cols: size.cols, rows: size.rows };
      opts.announce(lastAnnounced);
    }, settleMs);
  };

  const markAnnounced = (size: TermSize) => {
    lastAnnounced = { cols: size.cols, rows: size.rows };
  };

  const dispose = () => {
    disposed = true;
    if (frame !== null) { env.cancelAnimationFrame(frame); frame = null; }
    if (settleTimer !== null) { env.clearTimeout(settleTimer); settleTimer = null; }
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

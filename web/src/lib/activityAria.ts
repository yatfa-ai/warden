// The ONE producer of the Fleet Health "activity in the last 24 hours" screen-reader
// sentence (WARDEN-1080).
//
// Two widgets on the SAME Fleet Health page announce this sentence — the heatmap's
// per-row label (`heatmap.ts rowAriaLabel`, rendered by FleetActivityHeatmap) and the
// per-agent sparkline label (`agentSparkline.ts selectAgentSparkline`, rendered by
// HealthDashboard). Both used to hand-write the template, and they drifted: for an
// agent with events but zero errors the heatmap row said "5 events in the last 24
// hours" while its own sparkline said "5 events, 0 errors in the last 24 hours" — a
// user hears both, one after the other, on one screen.
//
// The grammar lives here so a change propagates to every producer instead of to one.
// Do NOT re-inline the template at a call site; delegate to this function.
export function activityAriaLabel(total: number, error: number): string {
  const events = `${total} event${total === 1 ? '' : 's'}`;
  // Suppress the errors clause at zero: a healthy agent should not announce
  // "0 errors" on every row. This was already the behavior of three of the four
  // pre-unification code paths; the fourth (the sparkline's active branch) was the
  // outlier and is now folded in here.
  if (error > 0) {
    return `${events}, ${error} error${error === 1 ? '' : 's'} in the last 24 hours`;
  }
  return `${events} in the last 24 hours`;
}

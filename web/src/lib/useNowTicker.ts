import { useEffect, useState } from 'react';

/**
 * A once-per-second clock, as React state.
 *
 * Both Observer live feeds (ActivityTimeline / DirectiveHistory) need a ticking
 * `now` for exactly two readers that must agree: the header's "Updated Ns ago"
 * label (`formatUpdatedAgo`) and the row grouping (`dayBucket`) — a row must
 * never sit under a `Today` heading that a second, differently-sampled clock
 * would call yesterday. Each feed had hand-copied the same
 * `useState(Date.now())` + `setInterval(…, 1000)` pair (WARDEN-1419), so this
 * is the one definition.
 *
 * Deliberately ONE ticker per feed, not one per consumer: the feed calls this
 * once and passes the value down (e.g. to LiveFeedChrome) rather than each
 * component mounting its own interval, so a feed can never render two clocks
 * that drift within the same frame.
 *
 * Returns ms-since-epoch, seeded lazily so the first render is not a stale
 * module-load timestamp.
 */
export function useNowTicker(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return now;
}

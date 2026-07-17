// Shared /api/hosts/status poll for host-list connectivity dots (WARDEN-113,
// WARDEN-198) and the Fleet Health Dashboard's per-host view (WARDEN-237).
// Rather than have each consumer start its own SSH-probing poll, this hook is a
// module-level singleton: one in-flight request, one ref-counted interval,
// shared by every consumer — App.tsx (host dots in the sidebar + full-page
// browser) and HealthDashboard. The poll is gated on Page Visibility so a
// backgrounded tab never burns SSH; on regaining focus it refreshes
// immediately (WARDEN-609).
//
// Mirrors useAttentionRollup's reasoning: a cheap local endpoint, deliberately
// kept as its own concern rather than folded into a shared /api/health context.

import { useEffect, useState } from 'react';
import type { HostConnectivity, HostConnectivityStatus } from '@/lib/healthUtils';

const POLL_MS = 30_000; // fixed host-dot cadence (see WARDEN-609: option (a))
const FRESH_MS = 5_000; // a response younger than this is reused as-is

// Module-level shared state (the singleton).
let cache: Record<string, HostConnectivity> = {};
let lastFetchAt = 0;
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let subscribers = 0;
const emit = new Set<(value: Record<string, HostConnectivity>) => void>();

function normalizeStatus(raw: string | undefined): HostConnectivityStatus {
  return raw === 'online' ? 'online' : raw === 'offline' ? 'offline' : 'unknown';
}

async function loadHostStatuses(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch('/api/hosts/status');
      if (!res.ok) return;
      const data = await res.json();
      const hosts = Array.isArray(data?.hosts) ? data.hosts : [];
      const next: Record<string, HostConnectivity> = {};
      for (const h of hosts as Array<{ host: string; status?: string; latency_ms?: number | null }>) {
        if (!h || typeof h.host !== 'string') continue;
        next[h.host] = { status: normalizeStatus(h.status), latency_ms: h.latency_ms ?? null };
      }
      cache = next;
      lastFetchAt = Date.now();
      for (const fn of emit) fn(cache);
    } catch {
      // Transient network blip — keep the last known statuses rather than wiping
      // connectivity to "unknown" on every flake.
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// Mirrors the App.tsx catalog poll's Page-Visibility gate: a backgrounded tab
// never burns SSH (every tick SSH-probes every host), and on regaining focus we
// refresh immediately because state may be stale while hidden.
function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    void loadHostStatuses();
  }
}

function ensurePolling() {
  if (timer) return;
  timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void loadHostStatuses();
  }, POLL_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function stopPollingIfIdle() {
  if (subscribers > 0 || !timer) return;
  clearInterval(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

/**
 * Subscribe to the shared /api/hosts/status poll. Returns the latest per-host
 * connectivity map (host -> { status, latency_ms }). Mounting the first
 * subscriber starts the 30s interval; unmounting the last one stops it, so the
 * poll only runs while something on screen needs it. Multiple consumers share a
 * single request (in-flight dedup + fresh-cache reuse), so adopting this hook in
 * more places never adds more polls.
 */
export function useHostStatuses(): Record<string, HostConnectivity> {
  const [statuses, setStatuses] = useState<Record<string, HostConnectivity>>(cache);

  useEffect(() => {
    subscribers += 1;
    emit.add(setStatuses);
    // Sync this consumer to whatever the singleton already knows (covers a fresh
    // mount mid-window so connectivity isn't blank for up to 30s).
    setStatuses(cache);
    // Prime immediately if stale, then keep polling on the shared cadence.
    if (Date.now() - lastFetchAt > FRESH_MS) void loadHostStatuses();
    ensurePolling();
    return () => {
      emit.delete(setStatuses);
      subscribers = Math.max(0, subscribers - 1);
      stopPollingIfIdle();
    };
  }, []);

  return statuses;
}

'use strict';

// WARDEN-1508 — the two process-memory SOURCES the Electron main process
// samples (see src/telemetry-process-memory.cjs for the bounded producer core):
//   • `main`     — the main process itself: process.memoryUsage() (rss +
//                  heapUsed) and process.uptime().
//   • `renderer` — the sum of the Tab processes' working sets from
//                  app.getAppMetrics(), sampled by MAIN. Electron reports
//                  workingSetSize in KILOBYTES; this converts to bytes. No heap
//                  is exposed for a renderer, so none is reported (the field is
//                  omitted, never faked). The age is the oldest live Tab's age
//                  (a reload/crash-recovery creating a new process resets it).
// Every collaborator is injected so the module is electron-free and unit-
// testable under `node --test`. The `server` runtime is NOT here: the forked
// server child samples itself and forwards over IPC.
//
// NUMBERS ONLY: a source returns three numbers (or null). It never sees, and
// cannot return, a path, hostname or name.

function createMainSource({ memoryUsage, uptimeSeconds }) {
  return {
    runtime: 'main',
    read() {
      const m = memoryUsage();
      return {
        rssBytes: m.rss,
        heapUsedBytes: m.heapUsed,
        ageMs: Math.round(uptimeSeconds() * 1000),
      };
    },
  };
}

function createRendererSource({ getAppMetrics, now = Date.now }) {
  return {
    runtime: 'renderer',
    read() {
      const tabs = getAppMetrics().filter((p) => p && p.type === 'Tab' && p.memory);
      if (tabs.length === 0) return null; // no renderer process right now — nothing to sample
      let kb = 0;
      let oldest = Infinity;
      for (const t of tabs) {
        kb += t.memory.workingSetSize;
        if (typeof t.creationTime === 'number' && t.creationTime < oldest) oldest = t.creationTime;
      }
      return {
        rssBytes: Math.round(kb * 1024),
        // heapUsedBytes deliberately absent — Electron exposes no renderer heap here.
        ageMs: Number.isFinite(oldest) ? Math.max(0, now() - oldest) : 0,
      };
    },
  };
}

module.exports = { createMainSource, createRendererSource };

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

/**
 * Router-level spec for createFleetRouter (src/fleetRoutes.js, moved out of server.js
 * by WARDEN-1891). Routes covered: GET /api/chats, /api/discover, /api/health,
 * /api/agent-states and /api/agent-states/fleet. The sibling suites
 * (server-agent-states, server-budget, temporary-sessions, request-telemetry-http*)
 * reach these routes only indirectly; this file pins the handler behaviour directly.
 *
 * Harness: the REAL router is mounted on a bare express app (never server.js — the
 * module-freeze hazard, WARDEN-130). `cfg` is a Proxy over a per-test object, the
 * chatCatalog is a recording stub, and getBudgetState is a thunk. A temp dir holding a
 * fake `tmux` (capture-pane prints "plain output") and a fake `ssh` (exit 255) is
 * prepended to PATH so the real pollAgentStates / pollFleetStates run with zero
 * network. HOME is frozen to a temp dir BEFORE the dynamic import (config.js /
 * activity.js read os.homedir() at load), and the companion transport is switched off.
 */

const LOCAL = '(local)';
const PANE_TEXT = 'plain output';

describe('createFleetRouter (bare express app)', () => {
  let originalHome, originalTransport, originalPath, tempDir;
  let server, baseUrl;

  // Per-test mutable state behind the injected collaborators.
  let cfgState, snapshotChats, snapshotThrows, catalogResult, refreshHostImpl;
  let budgetState, budgetThrows;
  let refreshHostCalls, refreshCatalogCalls;
  let cfgProxy;

  const get = async (p) => {
    const res = await fetch(`${baseUrl}${p}`);
    return { status: res.status, body: await res.json() };
  };

  const chat = (over = {}) => ({
    id: `${LOCAL}:x`, key: 'x', name: 'x', host: LOCAL, session: 'x',
    kind: 'yatfa', active: true, lastActivity: Date.now(), ...over,
  });

  before(async () => {
    originalHome = process.env.HOME;
    originalTransport = process.env.WARDEN_COMPANION_TRANSPORT;
    originalPath = process.env.PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fleetroutes-'));
    const bin = path.join(tempDir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\necho "${PANE_TEXT}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nexit 255\n', { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    process.env.HOME = tempDir;
    delete process.env.WARDEN_COMPANION_TRANSPORT;

    const { createFleetRouter } = await import('./fleetRoutes.js');

    cfgProxy = new Proxy({}, { get: (_t, k) => cfgState[k] });
    const chatCatalog = {
      snapshot() {
        if (snapshotThrows) throw new Error(snapshotThrows);
        return snapshotChats;
      },
      async refreshCatalog(cfg) {
        refreshCatalogCalls.push(cfg);
        return catalogResult;
      },
      async refreshHost(host, cfg) {
        refreshHostCalls.push({ host, cfg });
        return refreshHostImpl(host, cfg);
      },
    };
    const getBudgetState = () => {
      if (budgetThrows) throw new Error(budgetThrows);
      return budgetState;
    };

    const app = express();
    app.use(createFleetRouter({ cfg: cfgProxy, chatCatalog, getBudgetState }));
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => {
    cfgState = {};
    snapshotChats = [];
    snapshotThrows = null;
    catalogResult = { chats: [], errors: [] };
    refreshHostImpl = async () => [];
    budgetState = undefined;
    budgetThrows = null;
    refreshHostCalls = [];
    refreshCatalogCalls = [];
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalTransport === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = originalTransport;
    process.env.PATH = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('GET /api/chats', () => {
    it('lists the catalog chats minus temporary shells, passes errors through and hands cfg to refreshCatalog', async () => {
      catalogResult = {
        chats: [chat({ id: 'a', key: 'a' }), chat({ id: 't', key: 't', temporary: true }), chat({ id: 'b', key: 'b' })],
        errors: [{ host: 'h1', error: 'unreachable' }],
      };
      const { status, body } = await get('/api/chats');
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body.chats.map((c) => c.id), ['a', 'b']);
      assert.deepStrictEqual(body.errors, [{ host: 'h1', error: 'unreachable' }]);
      assert.strictEqual(refreshCatalogCalls.length, 1);
      assert.strictEqual(refreshCatalogCalls[0], cfgProxy);
    });
  });

  describe('GET /api/discover', () => {
    it('returns 400 with the message body for a missing ?host= and never refreshes', async () => {
      const { status, body } = await get('/api/discover');
      assert.strictEqual(status, 400);
      assert.deepStrictEqual(body, { error: 'missing ?host=' });
      assert.strictEqual(refreshHostCalls.length, 0);
    });

    it('returns 400 for an EMPTY ?host= and never refreshes', async () => {
      const { status, body } = await get('/api/discover?host=');
      assert.strictEqual(status, 400);
      assert.deepStrictEqual(body, { error: 'missing ?host=' });
      assert.strictEqual(refreshHostCalls.length, 0);
    });

    it('threads host and cfg to refreshHost and echoes the host in the response', async () => {
      refreshHostImpl = async () => [chat({ id: 'h1:a', key: 'a', host: 'h1' })];
      const { status, body } = await get('/api/discover?host=h1');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.host, 'h1');
      assert.strictEqual(refreshHostCalls.length, 1);
      assert.strictEqual(refreshHostCalls[0].host, 'h1');
      assert.strictEqual(refreshHostCalls[0].cfg, cfgProxy);
      assert.deepStrictEqual(body.chats.map((c) => c.id), ['h1:a']);
    });

    it('splits saved chats from temporaryChats (temporary shells ride beside, never inside chats)', async () => {
      refreshHostImpl = async () => [
        chat({ id: 'h1:a', key: 'a', host: 'h1' }),
        chat({ id: 'h1:t1', key: 't1', host: 'h1', temporary: true }),
        chat({ id: 'h1:b', key: 'b', host: 'h1' }),
        chat({ id: 'h1:t2', key: 't2', host: 'h1', temporary: true }),
      ];
      const { body } = await get('/api/discover?host=h1');
      assert.deepStrictEqual(body.chats.map((c) => c.id), ['h1:a', 'h1:b']);
      assert.deepStrictEqual(body.temporaryChats.map((c) => c.id), ['h1:t1', 'h1:t2']);
    });

    it('returns an empty split when the host has no chats', async () => {
      const { body } = await get('/api/discover?host=h9');
      assert.deepStrictEqual(body, { host: 'h9', chats: [], temporaryChats: [] });
    });

    it('returns 500 {error: message} when refreshHost rejects', async () => {
      refreshHostImpl = async () => { throw new Error('ssh exploded'); };
      const { status, body } = await get('/api/discover?host=h1');
      assert.strictEqual(status, 500);
      assert.deepStrictEqual(body, { error: 'ssh exploded' });
    });
  });

  describe('GET /api/health', () => {
    const healthOf = async (lastActivityAgoMs) => {
      snapshotChats = [chat({ lastActivity: Date.now() - lastActivityAgoMs })];
      const { body } = await get('/api/health');
      return body.agents[0].healthState;
    };

    it('wires healthWarningThresholdMin -> healthyMin and healthCriticalThresholdMin -> warningMin', async () => {
      cfgState = { healthWarningThresholdMin: 1, healthCriticalThresholdMin: 2 };
      assert.strictEqual(await healthOf(30 * 1000), 'healthy');
      assert.strictEqual(await healthOf(90 * 1000), 'warning');
      assert.strictEqual(await healthOf(180 * 1000), 'critical');
    });

    it('falls back to the 5/30 minute defaults when cfg carries no thresholds', async () => {
      assert.strictEqual(await healthOf(60 * 1000), 'healthy');
      assert.strictEqual(await healthOf(10 * 60 * 1000), 'warning');
      assert.strictEqual(await healthOf(45 * 60 * 1000), 'critical');
    });

    it('returns agents, groups, summary and a fresh numeric timestamp', async () => {
      cfgState = { healthWarningThresholdMin: 1, healthCriticalThresholdMin: 2 };
      const now = Date.now();
      snapshotChats = [
        chat({ id: 'h', key: 'h', lastActivity: now - 10 * 1000 }),
        chat({ id: 'w', key: 'w', lastActivity: now - 90 * 1000 }),
        chat({ id: 'c', key: 'c', lastActivity: now - 300 * 1000 }),
        chat({ id: 'z', key: 'z', active: false }),
      ];
      const before_ = Date.now();
      const { status, body } = await get('/api/health');
      const after_ = Date.now();
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body.agents.map((a) => [a.id, a.healthState]),
        [['h', 'healthy'], ['w', 'warning'], ['c', 'critical'], ['z', 'closed']]);
      assert.deepStrictEqual(body.groups.healthy.map((a) => a.id), ['h']);
      assert.deepStrictEqual(body.groups.warning.map((a) => a.id), ['w']);
      assert.deepStrictEqual(body.groups.critical.map((a) => a.id), ['c']);
      assert.deepStrictEqual(body.groups.closed.map((a) => a.id), ['z']);
      assert.strictEqual(body.summary.healthy, 1);
      assert.strictEqual(body.summary.warning, 1);
      assert.strictEqual(body.summary.critical, 1);
      assert.strictEqual(body.summary.closed, 1);
      assert.strictEqual(body.summary.total, 4);
      assert.match(body.summary.label, /1 healthy · 1 warning · 1 critical/);
      assert.strictEqual(typeof body.timestamp, 'number');
      assert.ok(body.timestamp >= before_ && body.timestamp <= after_);
    });

    it('drops temporary shells from every part of the response', async () => {
      snapshotChats = [chat({ id: 'a', key: 'a' }), chat({ id: 't', key: 't', temporary: true })];
      const { body } = await get('/api/health');
      assert.deepStrictEqual(body.agents.map((a) => a.id), ['a']);
      assert.strictEqual(body.summary.total, 1);
    });

    describe('token-spend join (cwd + host)', () => {
      const tokenOf = async (chats) => {
        snapshotChats = chats;
        const { status, body } = await get('/api/health');
        assert.strictEqual(status, 200);
        return body.agents.map((a) => a.tokenUsage);
      };

      it('attaches {total} when cwd and host both match a usage row', async () => {
        budgetState = { sessionUsage: [{ cwd: '/repo', host: 'h1', total: 1234 }] };
        const out = await tokenOf([chat({ id: 'h1:a', key: 'a', host: 'h1', cwd: '/repo' })]);
        assert.deepStrictEqual(out, [{ total: 1234 }]);
      });

      it('keeps the MAX total per key regardless of row order', async () => {
        const chats = [chat({ id: 'h1:a', key: 'a', host: 'h1', cwd: '/repo' })];
        budgetState = { sessionUsage: [
          { cwd: '/repo', host: 'h1', total: 100 },
          { cwd: '/repo', host: 'h1', total: 900 },
          { cwd: '/repo', host: 'h1', total: 500 },
        ] };
        assert.deepStrictEqual(await tokenOf(chats), [{ total: 900 }]);
        budgetState = { sessionUsage: [
          { cwd: '/repo', host: 'h1', total: 900 },
          { cwd: '/repo', host: 'h1', total: 100 },
        ] };
        assert.deepStrictEqual(await tokenOf(chats), [{ total: 900 }]);
      });

      it('ignores zero, null, negative and cwd-less usage rows (and null rows)', async () => {
        budgetState = { sessionUsage: [
          null,
          { cwd: '/repo', host: 'h1', total: 0 },
          { cwd: '/repo', host: 'h1', total: null },
          { cwd: '/repo', host: 'h1', total: -5 },
          { host: 'h1', total: 7000 },
          { cwd: '', host: 'h1', total: 8000 },
        ] };
        const out = await tokenOf([
          chat({ id: 'h1:a', key: 'a', host: 'h1', cwd: '/repo' }),
          chat({ id: 'h1:b', key: 'b', host: 'h1' }),
        ]);
        assert.deepStrictEqual(out, [undefined, undefined]);
      });

      it('attaches no chip to a non-matching chat or a cwd-less chat', async () => {
        budgetState = { sessionUsage: [{ cwd: '/repo', host: 'h1', total: 50 }] };
        const out = await tokenOf([
          chat({ id: 'h1:a', key: 'a', host: 'h1', cwd: '/other' }),
          chat({ id: 'h2:a', key: 'a', host: 'h2', cwd: '/repo' }),
          chat({ id: 'h1:c', key: 'c', host: 'h1' }),
        ]);
        assert.deepStrictEqual(out, [undefined, undefined, undefined]);
      });

      it('does not confuse a cwd/host boundary shift (/a+bc vs /ab+c)', async () => {
        budgetState = { sessionUsage: [{ cwd: '/a', host: 'bc', total: 42 }] };
        const out = await tokenOf([
          chat({ id: 'c:a', key: 'a', host: 'c', cwd: '/ab' }),
          chat({ id: 'bc:a', key: 'a2', host: 'bc', cwd: '/a' }),
        ]);
        assert.deepStrictEqual(out, [undefined, { total: 42 }]);
      });

      it('uses a separator that cannot occur in a path (a space-joined key would collide)', async () => {
        budgetState = { sessionUsage: [{ cwd: '/a b', host: 'c', total: 11 }] };
        const out = await tokenOf([
          chat({ id: 'b c:a', key: 'a', host: 'b c', cwd: '/a' }),
          chat({ id: 'c:a', key: 'a2', host: 'c', cwd: '/a b' }),
        ]);
        assert.deepStrictEqual(out, [undefined, { total: 11 }]);
      });

      it('tolerates a non-array or absent budget state (no chips, still 200)', async () => {
        const chats = [chat({ id: 'h1:a', key: 'a', host: 'h1', cwd: '/repo' })];
        for (const state of [undefined, null, {}, { sessionUsage: null }, { sessionUsage: { cwd: '/repo' } }, { sessionUsage: 'x' }]) {
          budgetState = state;
          assert.deepStrictEqual(await tokenOf(chats), [undefined], JSON.stringify(state));
        }
      });

      it('reads the budget thunk on every request (lazy, not captured at mount)', async () => {
        const chats = [chat({ id: 'h1:a', key: 'a', host: 'h1', cwd: '/repo' })];
        budgetState = { sessionUsage: [{ cwd: '/repo', host: 'h1', total: 1 }] };
        assert.deepStrictEqual(await tokenOf(chats), [{ total: 1 }]);
        budgetState = { sessionUsage: [{ cwd: '/repo', host: 'h1', total: 2 }] };
        assert.deepStrictEqual(await tokenOf(chats), [{ total: 2 }]);
      });
    });

    it('returns 500 {error: message} when the catalog snapshot throws', async () => {
      snapshotThrows = 'snapshot boom';
      const { status, body } = await get('/api/health');
      assert.strictEqual(status, 500);
      assert.deepStrictEqual(body, { error: 'snapshot boom' });
    });

    it('returns 500 {error: message} when the budget thunk throws', async () => {
      budgetThrows = 'budget boom';
      const { status, body } = await get('/api/health');
      assert.strictEqual(status, 500);
      assert.deepStrictEqual(body, { error: 'budget boom' });
    });
  });

  describe('GET /api/agent-states', () => {
    const localChat = chat({ id: `${LOCAL}:l1`, key: 'l1', name: 'l1', host: LOCAL, session: 'l1' });
    const remoteA = chat({ id: 'h1:s', key: 's', name: 's', host: 'h1', session: 's' });
    const remoteB = chat({ id: 'h2:s', key: 's', name: 's', host: 'h2', session: 's' });

    it('returns an empty result for absent, blank, whitespace-only and comma-only ?panes=', async () => {
      snapshotChats = [localChat];
      for (const q of ['', '?panes=', '?panes=%20%20', '?panes=%20,%20', '?panes=,,']) {
        const { status, body } = await get(`/api/agent-states${q}`);
        assert.strictEqual(status, 200, q);
        assert.deepStrictEqual(body.agents, [], q);
        assert.strictEqual(body.total, 0, q);
        assert.strictEqual(typeof body.timestamp, 'number', q);
      }
    });

    it('returns an empty result for an unknown key', async () => {
      snapshotChats = [localChat];
      const { status, body } = await get('/api/agent-states?panes=nope');
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body.agents, []);
      assert.strictEqual(body.total, 0);
      assert.strictEqual(typeof body.timestamp, 'number');
    });

    it('classifies a local pane from the captured text and trims keys', async () => {
      snapshotChats = [localChat];
      const { body } = await get('/api/agent-states?panes=%20l1%20');
      assert.strictEqual(body.total, 1);
      assert.strictEqual(body.agents.length, 1);
      const a = body.agents[0];
      assert.strictEqual(a.id, `${LOCAL}:l1`);
      assert.strictEqual(a.key, 'l1');
      assert.strictEqual(a.host, LOCAL);
      assert.strictEqual(a.captureError, false);
      assert.strictEqual(a.state, 'idle');
      assert.ok(!('customMatch' in a));
    });

    it('matches by the host-qualified chat id as well as the bare key', async () => {
      snapshotChats = [localChat];
      const { body } = await get(`/api/agent-states?panes=${encodeURIComponent(`${LOCAL}:l1`)}`);
      assert.deepStrictEqual(body.agents.map((a) => a.id), [`${LOCAL}:l1`]);
    });

    it('returns an unreachable remote host as capture_failed (flagged, not dropped)', async () => {
      snapshotChats = [remoteA];
      const { body } = await get('/api/agent-states?panes=s');
      assert.strictEqual(body.total, 1);
      assert.strictEqual(body.agents[0].state, 'capture_failed');
      assert.strictEqual(body.agents[0].captureError, true);
      assert.strictEqual(body.agents[0].signal, null);
    });

    it('WARDEN-1223: a bare key naming a session on two hosts yields BOTH agents', async () => {
      snapshotChats = [remoteA, remoteB];
      const { body } = await get('/api/agent-states?panes=s');
      assert.strictEqual(body.total, 2);
      assert.deepStrictEqual(body.agents.map((a) => a.id).sort(), ['h1:s', 'h2:s']);
      assert.ok(body.agents.every((a) => a.state === 'capture_failed'));
    });

    it('WARDEN-1223: repeated keys and a key plus the id of the same chat are not duplicated', async () => {
      snapshotChats = [remoteA, remoteB];
      let r = await get('/api/agent-states?panes=s,s,s');
      assert.deepStrictEqual(r.body.agents.map((a) => a.id).sort(), ['h1:s', 'h2:s']);
      r = await get('/api/agent-states?panes=s,h1:s');
      assert.deepStrictEqual(r.body.agents.map((a) => a.id).sort(), ['h1:s', 'h2:s']);
      assert.strictEqual(r.body.total, 2);
      r = await get('/api/agent-states?panes=h1:s,h1:s');
      assert.deepStrictEqual(r.body.agents.map((a) => a.id), ['h1:s']);
    });

    it('classifies only the requested chats, not the whole catalogue', async () => {
      snapshotChats = [localChat, remoteA];
      const { body } = await get('/api/agent-states?panes=l1');
      assert.deepStrictEqual(body.agents.map((a) => a.id), [`${LOCAL}:l1`]);
    });

    it('cfg.watchPatterns produces customMatch on the classified row', async () => {
      snapshotChats = [localChat];
      cfgState = { watchPatterns: [{ name: 'plain-watch', mode: 'text', expression: 'PLAIN output', enabled: true }] };
      const { body } = await get('/api/agent-states?panes=l1');
      assert.deepStrictEqual(body.agents[0].customMatch, { pattern: 'plain-watch', line: PANE_TEXT });
    });

    it('a disabled or non-matching watch pattern yields no customMatch', async () => {
      snapshotChats = [localChat];
      cfgState = { watchPatterns: [
        { name: 'off', mode: 'text', expression: 'plain', enabled: false },
        { name: 'miss', mode: 'text', expression: 'absent-text', enabled: true },
      ] };
      const { body } = await get('/api/agent-states?panes=l1');
      assert.ok(!('customMatch' in body.agents[0]));
    });

    it('returns 500 {error: message} when the catalog snapshot throws', async () => {
      snapshotThrows = 'states boom';
      const { status, body } = await get('/api/agent-states?panes=l1');
      assert.strictEqual(status, 500);
      assert.deepStrictEqual(body, { error: 'states boom' });
    });
  });

  describe('GET /api/agent-states/fleet', () => {
    const fleetChats = () => [
      chat({ id: `${LOCAL}:l1`, key: 'l1', name: 'l1', host: LOCAL, session: 'l1' }),
      chat({ id: 'h1:s', key: 's', name: 's', host: 'h1', session: 's' }),
      chat({ id: 'h2:s', key: 's', name: 's', host: 'h2', session: 's' }),
      chat({ id: 'h1:r', key: 'r', name: 'r', host: 'h1', session: 'r' }),
    ];

    it('with the companion transport off, every row is sweep_skipped and total counts them', async () => {
      snapshotChats = fleetChats();
      const { status, body } = await get('/api/agent-states/fleet');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.total, 4);
      assert.strictEqual(body.agents.length, 4);
      for (const a of body.agents) {
        assert.strictEqual(a.state, 'sweep_skipped');
        assert.strictEqual(a.sweepSkipped, true);
        assert.strictEqual(a.signal, null);
      }
      assert.strictEqual(typeof body.timestamp, 'number');
    });

    it('?exclude= is trimmed and matches by bare key (both hosts of a shared key) or by id', async () => {
      snapshotChats = fleetChats();
      let r = await get('/api/agent-states/fleet?exclude=%20s%20');
      assert.deepStrictEqual(r.body.agents.map((a) => a.id), [`${LOCAL}:l1`, 'h1:r']);
      assert.strictEqual(r.body.total, 2);

      r = await get(`/api/agent-states/fleet?exclude=${encodeURIComponent('h1:s')}`);
      assert.deepStrictEqual(r.body.agents.map((a) => a.id), [`${LOCAL}:l1`, 'h2:s', 'h1:r']);

      r = await get('/api/agent-states/fleet?exclude=l1,%20h1:r%20');
      assert.deepStrictEqual(r.body.agents.map((a) => a.id), ['h1:s', 'h2:s']);
    });

    it('an empty or blank ?exclude= excludes nothing', async () => {
      snapshotChats = fleetChats();
      for (const q of ['', '?exclude=', '?exclude=%20,%20', '?exclude=,']) {
        const { body } = await get(`/api/agent-states/fleet${q}`);
        assert.strictEqual(body.total, 4, q);
      }
    });

    it('returns an empty fleet for an empty catalogue', async () => {
      const { body } = await get('/api/agent-states/fleet');
      assert.deepStrictEqual(body.agents, []);
      assert.strictEqual(body.total, 0);
    });

    it('returns 500 {error: message} when the catalog snapshot throws', async () => {
      snapshotThrows = 'fleet boom';
      const { status, body } = await get('/api/agent-states/fleet');
      assert.strictEqual(status, 500);
      assert.deepStrictEqual(body, { error: 'fleet boom' });
    });
  });
});

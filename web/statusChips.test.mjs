// Behavior spec for Fleet Health's per-agent status-chip layer
// (web/src/components/fleet-health/StatusChips.tsx — moved out of
// HealthDashboard.tsx by WARDEN-1937, next consumer AgentRow.tsx / WARDEN-1942).
//
// The module carries a "graceful N/A / null-is-quiet" contract the fleet row
// depends on: every chip has a null/zero gate, and a wrong gate renders false
// "⚑ 0 unmerged" / "↑ 0" noise or hides real stranded work on a 50-row fleet.
// Adjacent suites test the chips' INPUTS only (resourceTone, getHealthIcon,
// buildFleetGitStatus); nothing rendered a chip until this file.
//
// No front-end test runner exists, so (like companionIndicator.test.mjs) this
// loads the REAL StatusChips.tsx (TSX -> ESM via Vite's OXC transform) together
// with its real leaves (StatusDot, DiffStatChip, formatTokens, healthUtils) and
// renders with react-dom/server. Only the `@/lib/utils` alias is stubbed, with a
// plain class-join (assertions read literal class tokens, not merge semantics).
//
// Run: node --test statusChips.test.mjs   (or: npm test, from web/)
import { test, after } from 'node:test';
import { transformWithOxc } from 'vite';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-statusChips-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

async function transpile(srcRel, outName, rewrites = []) {
  const p = resolve(__dirname, srcRel);
  let code = (await transformWithOxc(readFileSync(p, 'utf8'), p, {})).code;
  for (const [re, to] of rewrites) code = code.replace(re, to);
  writeFileSync(join(tmpDir, outName), code);
}

writeFileSync(
  join(tmpDir, 'cn-stub.mjs'),
  'export function cn(...inputs) { return inputs.flat(Infinity).filter(Boolean).join(" "); }\n',
);
await transpile('src/lib/healthUtils.ts', 'healthUtils.mjs');
await transpile('src/lib/formatTokens.ts', 'formatTokens.mjs');
await transpile('src/components/StatusDot.tsx', 'StatusDot.mjs', [
  [/from ['"]@\/lib\/utils['"]/g, `from './cn-stub.mjs'`],
]);
await transpile('src/components/sidebar/DiffStatChip.tsx', 'DiffStatChip.mjs', [
  [/from ['"]@\/lib\/utils['"]/g, `from './cn-stub.mjs'`],
]);
await transpile('src/components/fleet-health/StatusChips.tsx', 'StatusChips.mjs', [
  [/from ['"]@\/components\/StatusDot['"]/g, `from './StatusDot.mjs'`],
  [/from ['"]\.\.\/sidebar\/DiffStatChip['"]/g, `from './DiffStatChip.mjs'`],
  [/from ['"]@\/lib\/formatTokens['"]/g, `from './formatTokens.mjs'`],
  [/from ['"]@\/lib\/healthUtils['"]/g, `from './healthUtils.mjs'`],
]);

const {
  memUsedShort, resourceLabel, resourceTitle, healthRank, healthTone,
  HealthDot, ResourceChip, TokenChip, WipChip, ConflictChip, BehindChip,
  UnpushedChip, StalledChip, StashChip,
} = await import(`${tmpDir}/StatusChips.mjs?t=${Date.now()}`);

const html = (C, props) => renderToStaticMarkup(createElement(C, props));
const attr = (markup, name) => {
  const m = markup.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1].replace(/&#x27;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&') : null;
};
const text = (markup) => markup.replace(/<[^>]*>/g, '').replace(/&gt;/g, '>').replace(/&lt;/g, '<');

// ---- helpers ---------------------------------------------------------------

test('memUsedShort keeps only the "used" half of a docker MemUsage string', () => {
  assert.equal(memUsedShort('310.2MiB / 2GiB'), '310.2MiB');
  assert.equal(memUsedShort('  1.5GiB  /8GiB'), '1.5GiB');
  assert.equal(memUsedShort('512MiB'), '512MiB');
});

test('memUsedShort suppresses empty input and docker\'s "--" placeholder', () => {
  assert.equal(memUsedShort(undefined), '');
  assert.equal(memUsedShort(''), '');
  assert.equal(memUsedShort('--'), '');
  assert.equal(memUsedShort('-- / --'), '');
  assert.equal(memUsedShort('   / 2GiB'), '');
});

test('resourceLabel rounds CPU%, joins parts with " · ", and omits absent parts', () => {
  assert.equal(resourceLabel({ cpuPct: 41.6, memUsage: '310.2MiB / 2GiB' }), '42% · 310.2MiB');
  assert.equal(resourceLabel({ cpuPct: 42.4 }), '42%');
  assert.equal(resourceLabel({ memUsage: '310.2MiB / 2GiB' }), '310.2MiB');
  assert.equal(resourceLabel({ cpuPct: 0 }), '0%', 'a measured 0% CPU is data, not absence');
  assert.equal(resourceLabel({ memUsage: '--' }), '');
  assert.equal(resourceLabel({}), '');
});

test('resourceTitle gives 1-dp CPU/mem percentages plus the raw usage string', () => {
  assert.equal(
    resourceTitle({ cpuPct: 41.64, memPct: 15.55, memUsage: '310.2MiB / 2GiB' }),
    'CPU 41.6% · Mem 15.6% · 310.2MiB / 2GiB',
  );
  assert.equal(resourceTitle({ cpuPct: 0, memPct: 0 }), 'CPU 0.0% · Mem 0.0%');
  assert.equal(resourceTitle({ memUsage: '1GiB / 2GiB' }), '1GiB / 2GiB');
  assert.equal(resourceTitle({}), '');
});

test('healthRank orders states by display order; unknown strings sort last (6)', () => {
  const order = ['healthy', 'warning', 'critical', 'idle', 'closed', 'unknown'];
  assert.deepEqual(order.map(healthRank), [0, 1, 2, 3, 4, 5]);
  assert.equal(healthRank('not-a-state'), 6);
});

test('healthTone maps every state to its StatusDot colour family', () => {
  assert.equal(healthTone('healthy'), 'green');
  assert.equal(healthTone('warning'), 'yellow');
  assert.equal(healthTone('critical'), 'red');
  assert.equal(healthTone('idle'), 'gray');
  assert.equal(healthTone('closed'), 'gray');
  assert.equal(healthTone('unknown'), 'muted');
  assert.equal(healthTone('garbage'), 'muted');
});

// ---- HealthDot -------------------------------------------------------------

test('HealthDot pairs the state glyph with an accessible name and tone', () => {
  const m = html(HealthDot, { state: 'critical' });
  assert.equal(attr(m, 'aria-label'), 'Critical');
  assert.equal(text(m), '✕');
  assert.ok(m.includes('text-red-500'));
  const h = html(HealthDot, { state: 'healthy' });
  assert.equal(attr(h, 'aria-label'), 'Healthy');
  assert.equal(text(h), '✓');
  assert.ok(h.includes('text-green-500'));
});

// ---- ResourceChip ----------------------------------------------------------

test('ResourceChip renders nothing when the agent carries no resource data', () => {
  assert.equal(html(ResourceChip, { agent: {} }), '');
  assert.equal(html(ResourceChip, { agent: { memUsage: '--' } }), '');
});

test('ResourceChip shows label + tooltip, and a 0% CPU still renders', () => {
  const m = html(ResourceChip, { agent: { cpuPct: 0, memPct: 1, memUsage: '10MiB / 2GiB' } });
  assert.equal(text(m), '0% · 10MiB');
  assert.equal(attr(m, 'title'), 'CPU 0.0% · Mem 1.0% · 10MiB / 2GiB');
  assert.ok(m.includes('text-muted-foreground'));
});

test('ResourceChip tone bands: calm / amber ≥80 / red ≥90 (CPU or mem)', () => {
  assert.ok(html(ResourceChip, { agent: { cpuPct: 79, memPct: 10 } }).includes('text-muted-foreground'));
  assert.ok(html(ResourceChip, { agent: { cpuPct: 80, memPct: 10 } }).includes('text-yellow-500'));
  assert.ok(html(ResourceChip, { agent: { cpuPct: 10, memPct: 85 } }).includes('text-yellow-500'));
  assert.ok(html(ResourceChip, { agent: { cpuPct: 90, memPct: 10 } }).includes('text-red-500'));
  assert.ok(html(ResourceChip, { agent: { cpuPct: 10, memPct: 95 } }).includes('text-red-500'));
});

// ---- TokenChip -------------------------------------------------------------

test('TokenChip is quiet without usage (absent / 0)', () => {
  assert.equal(html(TokenChip, { agent: {} }), '');
  assert.equal(html(TokenChip, { agent: { tokenUsage: {} } }), '');
  assert.equal(html(TokenChip, { agent: { tokenUsage: { total: 0 } } }), '');
});

test('TokenChip formats the lifetime total and explains the join in its tooltip', () => {
  const m = html(TokenChip, { agent: { tokenUsage: { total: 12_345 } } });
  assert.equal(text(m), '12.3k tok');
  assert.match(attr(m, 'title'), /^Token spend \(lifetime total of the budget session this agent joined\): 12.3k tok\./);
  assert.match(attr(m, 'title'), /Matched by cwd \+ host/);
  assert.ok(m.includes('text-amber-500/80'));
  assert.equal(text(html(TokenChip, { agent: { tokenUsage: { total: 950 } } })), '950 tok');
  assert.equal(text(html(TokenChip, { agent: { tokenUsage: { total: 2_500_000 } } })), '2.5M tok');
});

// ---- WipChip ---------------------------------------------------------------

test('WipChip renders only for a dirty (clean === false) agent', () => {
  const ds = { insertions: 3, deletions: 1 };
  assert.equal(html(WipChip, { status: undefined }), '');
  assert.equal(html(WipChip, { status: null }), '');
  assert.equal(html(WipChip, { status: { clean: true, diffstat: ds } }), '');
  assert.equal(html(WipChip, { status: { clean: null, diffstat: ds } }), '', 'null clean is quiet');
  const m = html(WipChip, { status: { clean: false, diffstat: ds } });
  assert.ok(m.includes('+3') && m.includes('−1'));
  assert.equal(
    attr(m, 'title'),
    'uncommitted working-tree WIP — +3 −1 (insertions/deletions vs HEAD)',
  );
});

test('WipChip hides an all-untracked dirty agent (no +0 −0 lie)', () => {
  assert.equal(html(WipChip, { status: { clean: false, diffstat: null } }), '');
  assert.equal(html(WipChip, { status: { clean: false } }), '');
  assert.equal(html(WipChip, { status: { clean: false, diffstat: { insertions: 0, deletions: 0 } } }), '');
});

test('WipChip shows one-sided magnitudes (+3 −0 and +0 −2)', () => {
  const a = html(WipChip, { status: { clean: false, diffstat: { insertions: 3, deletions: 0 } } });
  assert.match(attr(a, 'title'), /\+3 −0/);
  const b = html(WipChip, { status: { clean: false, diffstat: { insertions: 0, deletions: 2 } } });
  assert.match(attr(b, 'title'), /\+0 −2/);
});

// ---- ConflictChip ----------------------------------------------------------

test('ConflictChip: null / 0 / negative are quiet; >0 renders ⚑ N unmerged', () => {
  assert.equal(html(ConflictChip, { status: undefined }), '');
  assert.equal(html(ConflictChip, { status: null }), '');
  assert.equal(html(ConflictChip, { status: { conflictCount: 0 } }), '');
  assert.equal(html(ConflictChip, { status: { conflictCount: -1 } }), '');
  const one = html(ConflictChip, { status: { conflictCount: 1 } });
  assert.equal(text(one), '⚑ 1 unmerged');
  assert.match(attr(one, 'title'), /^merge conflict — 1 unmerged path \(/);
  assert.ok(one.includes('text-rose-400 hover:text-rose-300'));
  const many = html(ConflictChip, { status: { conflictCount: 3 } });
  assert.equal(text(many), '⚑ 3 unmerged');
  assert.match(attr(many, 'title'), /^merge conflict — 3 unmerged paths \(/);
});

// ---- BehindChip ------------------------------------------------------------

test('BehindChip: null / 0 / negative are quiet; >0 renders ↓ N', () => {
  assert.equal(html(BehindChip, { status: undefined }), '');
  assert.equal(html(BehindChip, { status: { behind: null } }), '');
  assert.equal(html(BehindChip, { status: { behind: 0 } }), '');
  assert.equal(html(BehindChip, { status: { behind: -2 } }), '');
  const one = html(BehindChip, { status: { behind: 1 } });
  assert.equal(text(one), '↓ 1');
  assert.match(attr(one, 'title'), /^1 commit behind upstream /);
  assert.ok(one.includes('text-blue-400 hover:text-blue-300'));
  const many = html(BehindChip, { status: { behind: 4 } });
  assert.equal(text(many), '↓ 4');
  assert.match(attr(many, 'title'), /^4 commits behind upstream /);
});

// ---- UnpushedChip ----------------------------------------------------------

test('UnpushedChip: null / 0 / negative are quiet; >0 renders ↑ N', () => {
  assert.equal(html(UnpushedChip, { status: undefined }), '');
  assert.equal(html(UnpushedChip, { status: { ahead: null } }), '');
  assert.equal(html(UnpushedChip, { status: { ahead: 0 } }), '');
  assert.equal(html(UnpushedChip, { status: { ahead: -1 } }), '');
  const one = html(UnpushedChip, { status: { ahead: 1 } });
  assert.equal(text(one), '↑ 1');
  assert.match(attr(one, 'title'), /^1 commit unpushed to upstream /);
  assert.ok(one.includes('text-amber-400 hover:text-amber-300'));
  const many = html(UnpushedChip, { status: { ahead: 5 } });
  assert.equal(text(many), '↑ 5');
  assert.match(attr(many, 'title'), /^5 commits unpushed to upstream /);
});

// ---- StalledChip -----------------------------------------------------------

test('StalledChip renders only for stalled === true (strict)', () => {
  assert.equal(html(StalledChip, { status: undefined }), '');
  assert.equal(html(StalledChip, { status: null }), '');
  assert.equal(html(StalledChip, { status: { stalled: false } }), '');
  assert.equal(html(StalledChip, { status: { stalled: null } }), '');
  assert.equal(html(StalledChip, { status: { stalled: 'yes' } }), '', 'truthy non-true is quiet');
  assert.equal(html(StalledChip, { status: { stalled: 1 } }), '');
  const m = html(StalledChip, { status: { stalled: true } });
  assert.equal(text(m), '💤');
  assert.match(attr(m, 'title'), /^stalled \(>7d\) — last commit is >7d old/);
  assert.ok(m.includes('text-sky-400 hover:text-sky-300'));
});

// ---- StashChip -------------------------------------------------------------

test('StashChip: null / 0 / negative are quiet; >0 renders 🗄 N with plural title', () => {
  assert.equal(html(StashChip, { status: undefined }), '');
  assert.equal(html(StashChip, { status: { stashCount: null } }), '');
  assert.equal(html(StashChip, { status: { stashCount: 0 } }), '');
  assert.equal(html(StashChip, { status: { stashCount: -1 } }), '');
  const one = html(StashChip, { status: { stashCount: 1 } });
  assert.equal(text(one), '🗄 1');
  assert.match(attr(one, 'title'), /^1 parked stash — /);
  assert.ok(one.includes('text-fuchsia-400 hover:text-fuchsia-300'));
  const many = html(StashChip, { status: { stashCount: 2 } });
  assert.equal(text(many), '🗄 2');
  assert.match(attr(many, 'title'), /^2 parked stashes — /);
});

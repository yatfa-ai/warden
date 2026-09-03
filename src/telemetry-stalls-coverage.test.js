// COVERAGE GUARD for the server-stall culprit-key mapping (WARDEN-1278).
//
// The mapping in src/telemetry-stalls.cjs projects loop-monitor span labels onto
// CLOSED SETS. Closed sets are only closed while they match reality, and both
// halves drift for the same banal reason: someone adds a route or a traced
// sweep and has no reason to think about a telemetry aggregate.
//
// WHAT DRIFT COSTS. It is a LOSS OF RESOLUTION, never a leak — an unrecognized
// segment folds to the `id` placeholder and an unrecognized scoped label folds
// to the overflow bucket, so no user data can ride either way. But losing
// resolution is exactly how an aggregate stops being able to name a culprit,
// which is the entire reason this event type exists: WARDEN-977 built the
// attribution machinery precisely because three passes at the ~10s Settings hang
// could not name what was blocking. An aggregate that reports "other" is the
// modern version of that failure.
//
// So this test reads src/server.js and src/companion.js and fails the build when
// a NEW span label appears that the mapping does not know about. It is the same
// discipline src/loop-monitor-coverage.test.js applies to SYNC_FS_METHODS.
//
// Run: node --test src/telemetry-stalls-coverage.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROUTE_SEGMENTS, SCOPED_LABEL_NAMES, culpritKey, OVERFLOW_CULPRIT } = require('./telemetry-stalls.cjs');

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const sourceFiles = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .map((f) => ({ name: f, text: readFileSync(join(SRC_DIR, f), 'utf8') }));

const serverSource = readFileSync(join(SRC_DIR, 'server.js'), 'utf8');

test('every listed ROUTE_SEGMENT is actually USABLE as a key (letters + hyphens only)', () => {
  // A digit-bearing segment is deliberately folded to `id` by the mapper (see
  // SAFE_KEY_RE's note on the redactor's high-entropy rule), so listing one here
  // would be a lie: the list would claim a resolution the mapper does not
  // provide. Every route warden has today is digit-free, and this keeps the list
  // and the mapper honest with each other if that ever changes.
  const unusable = ROUTE_SEGMENTS.filter((s) => !/^[a-z][a-z-]*$/.test(s));
  assert.deepEqual(
    unusable,
    [],
    'ROUTE_SEGMENTS lists a segment the culprit-key mapper cannot actually use — '
    + 'a digit-bearing segment always folds to `id`, so listing it promises resolution that does not exist.',
  );
});

test('every STATIC route segment in server.js is a known culprit-key segment', () => {
  // The vendored fallback list. In production server.js injects the LIVE set
  // derived from the express router, so this guard is about the standalone /
  // unit-test path AND about keeping the documented list honest.
  const known = new Set(ROUTE_SEGMENTS);
  const missing = new Set();
  const routeRe = /app\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = routeRe.exec(serverSource)) !== null) {
    for (const seg of m[1].split('/')) {
      if (!seg || seg.startsWith(':')) continue; // a param is `id` BY DESIGN
      // A digit-bearing segment can never be a key (see the mapper's SAFE_KEY_RE
      // note): it folds to `id` unconditionally, so it is not "missing" from the
      // list — it is structurally out of scope for it.
      if (!/^[a-z][a-z-]*$/.test(seg)) continue;
      if (!known.has(seg)) missing.add(seg);
    }
  }
  assert.deepEqual(
    [...missing],
    [],
    'a new route segment landed without being added to ROUTE_SEGMENTS in src/telemetry-stalls.cjs — '
    + 'the stall aggregate can no longer distinguish that route (it folds to `id`). '
    + 'Add the segment(s) listed above.',
  );
});

test('every traced SPAN LABEL in src/ maps to a real culprit key, not the overflow bucket', () => {
  // `loopMonitor.trace('sweep:budget', …)` / `monitor.begin('ws:pane-monitor')`
  // — the literal-argument call sites. A label that folds to `other` is a
  // culprit the aggregate can no longer name.
  const labelRe = /(?:loopMonitor|monitor)\.(?:trace|begin)\(\s*'([^']+)'/g;
  const found = new Map(); // label -> file
  for (const { name, text } of sourceFiles) {
    let m;
    while ((m = labelRe.exec(text)) !== null) found.set(m[1], name);
    labelRe.lastIndex = 0;
  }
  assert.ok(found.size > 0, 'the scan found at least one literal span label (the regex still matches reality)');
  const unmapped = [...found.entries()].filter(([label]) => culpritKey(label) === OVERFLOW_CULPRIT);
  assert.deepEqual(
    unmapped.map(([label, file]) => `${label} (${file})`),
    [],
    'a traced span label folds to the overflow bucket — add it to SCOPED_LABEL_NAMES (or BARE_LABELS) '
    + 'in src/telemetry-stalls.cjs so the stall aggregate can still name it.',
  );
});

test('the sweep supervisor\'s DERIVED labels are known too (`sweep:<name>`)', () => {
  // createSweepSupervisor builds its label as `sweep:${name}`, so the literal
  // never appears at a trace() call site and the scan above cannot see it. The
  // NAME does appear, as `name: 'budget'` in each supervisor's options.
  const nameRe = /createSweepSupervisor\(\{\s*\n\s*name:\s*'([^']+)'/g;
  const names = [];
  let m;
  while ((m = nameRe.exec(serverSource)) !== null) names.push(m[1]);
  assert.ok(names.length >= 3, `expected the three resident sweeps, found ${JSON.stringify(names)}`);
  const unmapped = names.filter((n) => culpritKey(`sweep:${n}`) === OVERFLOW_CULPRIT);
  assert.deepEqual(
    unmapped.map((n) => `sweep:${n}`),
    [],
    'a sweep supervisor\'s derived label is not in SCOPED_LABEL_NAMES (src/telemetry-stalls.cjs).',
  );
});

test('SCOPED_LABEL_NAMES carries no entry that no longer exists in src/', () => {
  // The other drift direction: a stale entry is harmless on the wire but is a
  // lie about what the codebase does, and it makes the set stop being reviewable.
  const allSource = sourceFiles.map((f) => f.text).join('\n');
  const stale = [...SCOPED_LABEL_NAMES].filter((label) => {
    const [, name] = label.split(':');
    // Either the whole literal appears (a trace() call site) or the sweep NAME
    // does (the supervisor's derived label).
    return !allSource.includes(`'${label}'`) && !allSource.includes(`name: '${name}'`);
  });
  assert.deepEqual(stale, [], 'SCOPED_LABEL_NAMES names a span label src/ no longer emits — remove it.');
});

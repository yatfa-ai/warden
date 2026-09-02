// Regression guard for out-of-order responses in the two MANUALLY-fired search
// legs — WorkspaceSearchDialog.doSearch and GlobalSearchDialog.doSearch
// (WARDEN-1049).
//
// THE DEFECT, in two halves:
//
//   A. Both dialogs gate their Search *Button* on `disabled={searching || ...}`
//      but left the *Enter* handler ungated — and Enter is the primary
//      interaction, since both auto-focus the input on open. So the one-search-
//      at-a-time invariant the Button implements was walked around by the
//      keyboard, and two searches could overlap. Nothing sequenced the
//      responses, so the older one could land last and win: the input showed the
//      new query while the rows belonged to the query it replaced.
//
//   B. Worse, neither leg cared whether its dialog was still OPEN. The
//      reset-on-close effect clears query/results/error; an in-flight fetch
//      resolving afterwards re-populated `results`, so reopening the dialog
//      rendered the PREVIOUS session's hits under an empty query box.
//
// WHY THE TEST IS SHAPED LIKE THIS: this repo has no front-end DOM test runner
// (`web/package.json` is `"test": "node --test"`, with zero jsdom / testing-
// library / vitest / happy-dom devDependencies), and WARDEN-1049 explicitly
// scopes out introducing one. So the fix is verified from two directions, the
// same division of labour web/dialogMaxWidth.test.mjs uses:
//
//   PART 1 (behavioural) drives the REAL sequencing primitive — src/lib/
//   latestOnly.ts, loaded through Vite's OXC transform exactly as
//   snooze.test.mjs loads snooze.ts — through overlapping invocations in which
//   the FIRST resolves LAST. A sequential test would pass against the defective
//   code by construction and prove nothing: safe and unsafe inputs here differ
//   only by INTERLEAVING, so the interleaving IS the input.
//
//   PART 2 (static source guard) pins the defect CLASS in the components, which
//   no unit test can reach: that every fetch leg writing search results guards
//   its writes, and that no keyboard path bypasses an in-flight gate its click
//   path enforces. Following the WARDEN-994 discipline, it pins no individual
//   call site's spelling — it survives rename/reformat and fails only on
//   reintroduction, in these two dialogs or in a third one added later.
//
// Run: node --test searchRaceGuard.test.mjs   (from web/)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, 'src');

// --- Load the REAL src/lib/latestOnly.ts (TS -> ESM via Vite's OXC transform) ---
// Zero runtime imports in that module, so the emitted file loads standalone.
const helperPath = path.resolve(__dirname, 'src/lib/latestOnly.ts');
const { code } = await transformWithOxc(readFileSync(helperPath, 'utf8'), helperPath, {});
const tmpDir = mkdtempSync(path.join(tmpdir(), 'warden-latest-only-test-'));
const tmpFile = path.join(tmpDir, 'latestOnly.mjs');
writeFileSync(tmpFile, code);
const { claimLatest, supersedeInFlight } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// PART 1 — behavioural: the interleavings the components can actually hit
// ---------------------------------------------------------------------------

/** A promise whose settlement this test controls, so response ORDER is an input. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * A faithful stand-in for the shipped `doSearch` bodies: same claim-then-gate
 * structure, same write sites (`results`, `error`, and the `searching` flag in
 * `finally`), same reset-on-close. Only the fetch and the React setters are
 * substituted — the SEQUENCING is the real module, which is the thing under
 * test. `writes` records every state write so a test can assert not just the
 * final state but that a superseded response wrote *nothing at all*.
 */
function makeSearchLeg() {
  const gen = { current: 0 };
  const state = { results: [], error: null, searching: false };
  const writes = [];

  const doSearch = async (label, fetchLeg) => {
    const isLatest = claimLatest(gen);
    state.searching = true;
    state.error = null;
    try {
      const data = await fetchLeg();
      if (!isLatest()) return;
      if (data.error) {
        state.error = data.error;
        state.results = [];
        writes.push(`${label}:error`);
      } else {
        state.results = data.results;
        writes.push(`${label}:results`);
      }
    } catch (e) {
      if (!isLatest()) return;
      state.error = e.message;
      state.results = [];
      writes.push(`${label}:error`);
    } finally {
      if (isLatest()) {
        state.searching = false;
        writes.push(`${label}:searching=false`);
      }
    }
  };

  // The reset-on-close effect: supersede first, then clear.
  const closeDialog = () => {
    supersedeInFlight(gen);
    state.results = [];
    state.error = null;
    state.searching = false;
  };

  return { state, writes, doSearch, closeDialog };
}

const rows = (q) => [{ file: `${q}.ts`, line: 1, text: `hit for ${q}` }];

describe('overlapping manual searches (WARDEN-1049 scenario A)', () => {
  it('the newest query wins even when its response arrives FIRST', async () => {
    // The load-bearing interleaving: search 1 is issued first and resolves LAST.
    // Against the unguarded code this is exactly the case that renders search 1's
    // rows under search 2's query.
    const leg = makeSearchLeg();
    const first = deferred();
    const second = deferred();

    const p1 = leg.doSearch('import', () => first.promise);
    const p2 = leg.doSearch('export', () => second.promise);

    second.resolve({ results: rows('export') });
    await p2;
    first.resolve({ results: rows('import') });
    await p1;

    assert.deepEqual(
      leg.state.results,
      rows('export'),
      'the surviving results must belong to the SECOND (newest) query — a stale '
      + 'response that lands last must not overwrite it',
    );
    assert.deepEqual(
      leg.writes.filter((w) => w.startsWith('import:')),
      [],
      'the superseded invocation must write nothing at all',
    );
  });

  it('a superseded response does not clear the spinner of the search still running', async () => {
    // The `finally` guard specifically. Search 1 resolves while search 2 is still
    // in flight: an unguarded `finally` would flip `searching` to false and stop
    // the indicator for a search that has not finished.
    const leg = makeSearchLeg();
    const first = deferred();
    const second = deferred();

    const p1 = leg.doSearch('import', () => first.promise);
    const p2 = leg.doSearch('export', () => second.promise);

    first.resolve({ results: rows('import') });
    await p1;

    assert.deepEqual(leg.state.results, [], 'the stale response must write no rows');
    assert.equal(
      leg.state.searching,
      true,
      'the newer search is still in flight, so the spinner must stay up',
    );

    second.resolve({ results: rows('export') });
    await p2;
    assert.deepEqual(leg.state.results, rows('export'));
    assert.equal(leg.state.searching, false, 'the newest search clears its own spinner');
  });

  it('a superseded FAILURE does not raise an error banner over fresh results', async () => {
    const leg = makeSearchLeg();
    const first = deferred();
    const second = deferred();

    const p1 = leg.doSearch('import', () => first.promise);
    const p2 = leg.doSearch('export', () => second.promise);

    second.resolve({ results: rows('export') });
    await p2;
    first.reject(new Error('Search failed'));
    await p1;

    assert.equal(leg.state.error, null, 'a stale failure must not annotate a fresh success');
    assert.deepEqual(leg.state.results, rows('export'));
  });
});

describe('a response landing after the dialog closes (WARDEN-1049 scenario B)', () => {
  it('writes nothing, so reopening shows the placeholder rather than stale rows', async () => {
    const leg = makeSearchLeg();
    const inFlight = deferred();
    const p = leg.doSearch('import', () => inFlight.promise);

    leg.closeDialog(); // reset effect: supersede + clear
    inFlight.resolve({ results: rows('import') });
    await p;

    assert.deepEqual(
      leg.state.results,
      [],
      'a fetch resolving after close must not re-populate the results the reset '
      + 'effect just cleared — that is what renders the previous session\'s hits '
      + 'under an empty query box',
    );
    assert.equal(leg.state.error, null);
    assert.equal(leg.state.searching, false, 'the dialog must not reopen stuck in a search');
    assert.deepEqual(leg.writes, [], 'the post-close response must write nothing at all');
  });

  it('a failure landing after close is equally silent', async () => {
    const leg = makeSearchLeg();
    const inFlight = deferred();
    const p = leg.doSearch('import', () => inFlight.promise);

    leg.closeDialog();
    inFlight.reject(new Error('Search failed'));
    await p;

    assert.equal(leg.state.error, null, 'a closed dialog must not bank an error banner for its next open');
    assert.deepEqual(leg.writes, []);
  });

  it('the next search after a close still works (the guard is not one-shot)', async () => {
    const leg = makeSearchLeg();
    const abandoned = deferred();
    const p1 = leg.doSearch('import', () => abandoned.promise);
    leg.closeDialog();

    await leg.doSearch('export', () => Promise.resolve({ results: rows('export') }));
    assert.deepEqual(leg.state.results, rows('export'), 'reopening and searching again must write normally');
    assert.equal(leg.state.searching, false);

    abandoned.resolve({ results: rows('import') });
    await p1;
    assert.deepEqual(leg.state.results, rows('export'), 'the abandoned response stays superseded forever');
  });
});

describe('the guard leaves the ordinary paths alone', () => {
  it('a single search writes its results and clears its spinner', async () => {
    const leg = makeSearchLeg();
    await leg.doSearch('import', () => Promise.resolve({ results: rows('import') }));
    assert.deepEqual(leg.state.results, rows('import'));
    assert.equal(leg.state.searching, false);
    assert.deepEqual(leg.writes, ['import:results', 'import:searching=false']);
  });

  it('a single search surfaces its error (the WARDEN-89 gate still fires)', async () => {
    const leg = makeSearchLeg();
    await leg.doSearch('import', () => Promise.resolve({ error: 'no cwd for this chat' }));
    assert.equal(leg.state.error, 'no cwd for this chat');
    assert.deepEqual(leg.state.results, []);
    assert.equal(leg.state.searching, false);
  });

  it('sequential searches each win in turn', async () => {
    const leg = makeSearchLeg();
    await leg.doSearch('import', () => Promise.resolve({ results: rows('import') }));
    assert.deepEqual(leg.state.results, rows('import'));
    await leg.doSearch('export', () => Promise.resolve({ results: rows('export') }));
    assert.deepEqual(leg.state.results, rows('export'));
  });
});

describe('latestOnly primitives', () => {
  it('only the newest claim reads latest', () => {
    const ref = { current: 0 };
    const a = claimLatest(ref);
    assert.equal(a(), true, 'the only claim outstanding is the newest');
    const b = claimLatest(ref);
    assert.equal(a(), false);
    assert.equal(b(), true);
  });

  it('supersedeInFlight invalidates without claiming', () => {
    const ref = { current: 0 };
    const a = claimLatest(ref);
    supersedeInFlight(ref);
    assert.equal(a(), false, 'the close path must invalidate everything outstanding');
    const b = claimLatest(ref);
    assert.equal(b(), true, 'and must not block the next claim');
  });
});

// ---------------------------------------------------------------------------
// PART 2 — static source guard over the components themselves
// ---------------------------------------------------------------------------

/** Every .ts/.tsx source under web/src, recursively. */
function sourceFiles(dir = SRC_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [{ file: path.relative(SRC_DIR, full), text: stripComments(fs.readFileSync(full, 'utf8')) }];
  });
}

/**
 * Blank out comments, preserving offsets and line structure.
 *
 * Two reasons this matters more than it looks. (1) Prose apostrophes ("a pane's
 * host") would otherwise open a string state and swallow the rest of the scan.
 * (2) These files DISCUSS the guard at length in their comments — a scan that
 * counted a comment mention as the guard being present would pass on code that
 * only talks about sequencing. The invariants below must see code only.
 */
function stripComments(text) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; out += '  '; i++; continue; }
      if (ch === '/' && next === '*') { state = 'block'; out += '  '; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') state = ch;
      out += ch;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch; } else out += ' ';
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; out += '  '; i++; } else out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    // inside a string/template literal
    if (ch === '\\') { out += '  '; i++; continue; }
    if (ch === state) state = 'code';
    out += ch;
  }
  return out;
}

/** Brace-match from `open` (an index pointing at `{`) to its closer, string-aware. */
function matchBrace(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(open, i + 1); }
  }
  return text.slice(open);
}

/**
 * The body text of every `async` function in a file — arrow or declaration.
 * Bodies nest (an async mapper inside an async effect callback); each is
 * returned independently, and an outer body legitimately contains its inner
 * ones, which is what lets a guard held by the outer scope count for a write
 * the outer scope performs.
 */
function asyncBodies(text) {
  const bodies = [];
  const starts = /\basync\s*(?:function\s*[\w$]*\s*)?\([^)]*\)\s*(?::\s*[^=;{]{0,120})?(?:=>\s*)?\{/g;
  for (const m of text.matchAll(starts)) {
    bodies.push(matchBrace(text, m.index + m[0].length - 1));
  }
  return bodies;
}

const WRITES_RESULTS = /\bset[A-Za-z]*Results\s*\(/;
// WARDEN-1144: the bounded helpers count as a fetch. Every UI-gating read is now
// issued through `fetchBounded` / `fetchJson` (the shared deadline in lib/api.ts),
// so a matcher pinned to the bare `fetch(` spelling stops seeing the search legs
// entirely — and this scan's failure mode is a SILENT one: with zero legs found,
// the invariant above passes by checking nothing. (The `is actually scanning
// legs` guard below is what caught exactly that.) The negative controls at the
// bottom of this suite deliberately keep the bare spelling, which still matches.
const AWAITS_FETCH = /\bawait\s+fetch(?:Bounded|Json)?\s*\(/;
// The sequencing spellings this repo actually uses: the effect-scoped `cancelled`
// flag of the debounced legs, the generation gate of the manual legs, and an
// AbortController (accepted by WARDEN-1049, unused today) — any is sufficient.
const SEQUENCING_GUARD = /\bcancelled\b|\bisLatest\b|\bclaimLatest\b|\baborted\b|\bAbortController\b/;

describe('every search leg guards its post-await writes (WARDEN-1049)', () => {
  // The invariant a source scan CAN see: a leg that writes results after an
  // await must carry some sequencing guard. It deliberately does not try to
  // prove each individual write is gated — that is what Part 1 exercises on the
  // shipped primitive. What this catches is the thing that actually happened
  // here: a leg written with NO sequencing at all, copied from a sibling that
  // had none either, while three other legs in the same codebase had it.
  const legs = () => sourceFiles().flatMap(({ file, text }) =>
    asyncBodies(text)
      .filter((body) => AWAITS_FETCH.test(body) && WRITES_RESULTS.test(body))
      .map((body) => ({ file, body })));

  it('no fetch leg writes search results without one', () => {
    const offenders = legs()
      .filter(({ body }) => !SEQUENCING_GUARD.test(body))
      .map(({ file }) => file);
    assert.deepEqual(
      offenders,
      [],
      'an async leg that writes search results after an await, with nothing '
      + 'sequencing its response, lets a stale response overwrite a newer one and '
      + 'lets a post-close response repopulate state the reset effect just cleared. '
      + 'Guard the writes — `cancelled` for a debounced effect (it has a cleanup to '
      + 'hang the flag on), `claimLatest` from lib/latestOnly for an event handler '
      + '(it does not).',
    );
  });

  it('is actually scanning legs (guards against a silently-empty scan)', () => {
    // Without this, a refactor that breaks the scanner — a moved src dir, a leg
    // rewritten into a shape the matcher misses — turns the invariant above into
    // a test that passes by finding nothing, reporting safety it never checked.
    const found = legs();
    assert.ok(
      found.length >= 4,
      `expected the scanner to find the repo's search legs, found ${found.length}`,
    );
    const files = new Set(found.map((l) => l.file));
    for (const expected of [
      path.join('components', 'WorkspaceSearchDialog.tsx'),
      path.join('components', 'GlobalSearchDialog.tsx'),
      path.join('components', 'OpenChatBrowserPage.tsx'),
    ]) {
      assert.ok(files.has(expected), `expected the scan to reach ${expected}`);
    }
  });

  it('the scanner can see an unguarded leg (proves the invariant can fail)', () => {
    // The pre-fix shape of doSearch, verbatim in structure. If this stops being
    // reported, the invariant above has gone blind and its green means nothing.
    const unguarded = `
      const doSearch = async () => {
        setSearching(true);
        const res = await fetch('/api/search-files', { method: 'POST' });
        const data = await res.json();
        setResults(data.results);
      };`;
    const bodies = asyncBodies(stripComments(unguarded))
      .filter((b) => AWAITS_FETCH.test(b) && WRITES_RESULTS.test(b));
    assert.equal(bodies.length, 1, 'the scanner must find the leg');
    assert.equal(SEQUENCING_GUARD.test(bodies[0]), false, 'and must judge it unguarded');
  });

  it('a comment mentioning the guard does not satisfy it', () => {
    const commentOnly = `
      const doSearch = async () => {
        // a cancelled flag would prevent a stale write here
        const res = await fetch('/api/search-files');
        setResults(await res.json());
      };`;
    const bodies = asyncBodies(stripComments(commentOnly))
      .filter((b) => AWAITS_FETCH.test(b) && WRITES_RESULTS.test(b));
    assert.equal(bodies.length, 1);
    assert.equal(SEQUENCING_GUARD.test(bodies[0]), false);
  });
});

/** Text of every opening `<Name ...>` tag, reading past `>` inside prop expressions. */
function openingTags(text, name) {
  const tags = [];
  for (const match of text.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
    let depth = 0;
    let quote = null;
    for (let i = match.index; i < text.length; i++) {
      const ch = text[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) { tags.push(text.slice(match.index, i + 1)); break; }
    }
  }
  return tags;
}

/** The `{...}` expression of a JSX prop, brace-matched (so `a || b()` survives). */
function propExpression(tag, prop) {
  const at = tag.indexOf(`${prop}={`);
  if (at === -1) return null;
  const body = matchBrace(tag, tag.indexOf('{', at));
  return body.slice(1, -1);
}

/**
 * The identifiers in a `disabled={...}` expression that name an IN-FLIGHT mode
 * flag rather than a validity check — discriminated by whether the component
 * itself ever sets them true (`setSearching(true)`). `!query.trim()` is a
 * validity gate the keyboard path may legitimately re-derive; `searching` is a
 * concurrency gate the keyboard path must honour.
 */
function inFlightFlags(fileText, disabledExpr) {
  const idents = new Set([...disabledExpr.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
  return [...idents].filter((id) => new RegExp(
    `\\bset${id[0].toUpperCase()}${id.slice(1)}\\s*\\(\\s*true\\s*\\)`,
  ).test(fileText));
}

/** Every `onKeyDown={...}` handler expression that acts on Enter. */
function enterHandlers(text) {
  const handlers = [];
  for (const m of text.matchAll(/onKeyDown=\{/g)) {
    const body = matchBrace(text, text.indexOf('{', m.index + 'onKeyDown='.length - 1));
    if (/['"]Enter['"]/.test(body)) handlers.push(body);
  }
  return handlers;
}

describe('the keyboard path honours the in-flight gate the click path enforces (WARDEN-1049)', () => {
  // The reachability half of the defect. Both dialogs DID implement
  // one-search-at-a-time — on the Button only — while Enter, the primary
  // interaction, walked straight around it. This asserts the class: wherever a
  // component disables a Button on a flag it sets true itself, no Enter handler
  // invoking that same action may fire without testing the flag. It pins no
  // handler's spelling, so `!searching &&`, an early return, or a rename all pass.
  const pairs = () => sourceFiles().flatMap(({ file, text }) => {
    const found = [];
    for (const handler of enterHandlers(text)) {
      for (const call of handler.matchAll(/([A-Za-z_$][\w$]*)\s*\(\s*\)/g)) {
        const action = call[1];
        for (const tag of openingTags(text, 'Button')) {
          if (propExpression(tag, 'onClick') !== action) continue;
          const disabled = propExpression(tag, 'disabled');
          if (!disabled) continue;
          const flags = inFlightFlags(text, disabled);
          if (flags.length) found.push({ file, action, handler, flags });
        }
      }
    }
    return found;
  });

  it('no Enter handler fires a gated action without testing the gate', () => {
    const offenders = pairs()
      .filter(({ handler, flags }) => !flags.some((f) => new RegExp(`\\b${f}\\b`).test(handler)))
      .map(({ file, action, flags }) => `${file}: Enter fires ${action}() ignoring ${flags.join('/')}`);
    assert.deepEqual(
      offenders,
      [],
      'the Button for this action is disabled while it is in flight, but the Enter '
      + 'handler is not — and Enter is how these dialogs are actually driven (the '
      + 'input is auto-focused on open). Gate the handler on the same flag.',
    );
  });

  it('is actually scanning pairs (guards against a silently-empty scan)', () => {
    const found = pairs();
    assert.ok(
      found.length >= 2,
      `expected to find the gated Enter/Button pairs in both search dialogs, found ${found.length}`,
    );
    const files = new Set(found.map((p) => p.file));
    assert.ok(files.has(path.join('components', 'WorkspaceSearchDialog.tsx')));
    assert.ok(files.has(path.join('components', 'GlobalSearchDialog.tsx')));
  });

  it('the scanner can see an ungated handler (proves the invariant can fail)', () => {
    // The pre-fix markup, verbatim. If this stops being reported, the invariant
    // above has gone blind.
    const before = `
      const [searching, setSearching] = useState(false);
      const doSearch = async () => { setSearching(true); };
      <Input onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }} />
      <Button onClick={doSearch} disabled={searching || !query.trim()}>Search</Button>`;
    const text = stripComments(before);
    const handler = enterHandlers(text)[0];
    const tag = openingTags(text, 'Button')[0];
    const flags = inFlightFlags(text, propExpression(tag, 'disabled'));
    assert.deepEqual(flags, ['searching'], 'the in-flight flag is the one the component sets true');
    assert.equal(/\bsearching\b/.test(handler), false, 'and the pre-fix handler ignores it');
  });

  it('does not mistake a validity check for an in-flight gate', () => {
    // `!query.trim()` must NOT be demanded of the keyboard path: pressing Enter on
    // an empty box is already a no-op inside the action itself. Only flags the
    // component sets true count.
    const text = stripComments(`
      const [searching, setSearching] = useState(false);
      const doSearch = async () => { setSearching(true); };
      <Button onClick={doSearch} disabled={searching || !query.trim()}>Search</Button>`);
    const flags = inFlightFlags(text, propExpression(openingTags(text, 'Button')[0], 'disabled'));
    assert.deepEqual(flags, ['searching']);
  });
});

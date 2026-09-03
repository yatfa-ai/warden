import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tests for the attention-threshold blur clamp in
 * web/src/components/settings/sections/AttentionThresholdsSection.tsx
 * (WARDEN-1245).
 *
 * WHY THIS FILE EXISTS. The two Inputs are the REFERENCE implementation for
 * blur-clamping across Settings — HostsSection and ObserverSection carry
 * comments naming this section's clamp as the pattern they mirror. The backend
 * half of the contract is thoroughly covered (src/config-schema.test.js pins
 * the nullablePositiveNumber + crossField ordering guards, including the
 * inverted-pair and out-of-range cases), but the frontend half had ZERO
 * coverage: no suite referenced the component. And the behaviour it guards
 * has regressed before — the floor exists precisely because WARDEN-925 found
 * 0/negative values being silently refused by the backend's `value > 0` guard
 * while PUT /api/config still answered { ok: true }, so the field reverted on
 * the next open with no error ever shown. Nothing stopped that from coming
 * back. These tests pin the clamp as it stands so the next change to the
 * ordering or to either bound fails the suite instead of shipping.
 *
 * WHAT IS PINNED — the clamp's three load-bearing properties:
 *
 *   1. THE FLOOR (both fields): out-of-range values clamp UP to 1 on blur —
 *      the min the inputs advertise — composed so an out-of-range value can
 *      never survive this blur.
 *   2. THE PAIR ORDERING (warning field only): a warning that exceeds an
 *      explicitly-set critical clamps DOWN to it (WARDEN-374), mirroring the
 *      backend PUT guard so the committed value matches what persists.
 *   3. THE ASYMMETRY: the critical field floors ITSELF but deliberately never
 *      rewrites healthWarningThresholdMin — flooring critical can leave the
 *      pair inverted (warning 5 > critical 1) and that is accepted: the
 *      render-time ordering message fires immediately and the backend
 *      crossField guard clamps warning down on save. Rewriting a field the
 *      human never touched is worse.
 *
 * Plus the composition details the comments call out by name: the floor runs
 * FIRST and the ordering clamp re-floors the critical value it clamps down to
 * (`Math.max(1, c)` — never below the floor, even against a transiently sub-1
 * critical), and both steps compose into a SINGLE setConfig so the second
 * step cannot read a stale `config` closure. Null is the use-the-default path
 * and passes through unclamped in BOTH fields.
 *
 * Harness — the sparkline.test.mjs precedent (WARDEN-1243): transpile the REAL
 * source via Vite's OXC transform and import it under Node. The section is a
 * pure function returning an element tree — hookless, no browser APIs — so it
 * is invoked directly, the surrounding UI atoms (Input/Label/SettingsSection)
 * are stubbed at the module boundary, and the blur handlers are called
 * straight off the walked tree. No DOM, no browser test runner, no new
 * dependencies (vite is already a devDependency).
 *
 * Two traps from prior work in this harness, both handled on the SOURCE text
 * before the transform (quote-agnostic regexes, backreference-anchored,
 * because the transform normalises quote style):
 *   - the `import { type ConfigData, type SetConfig } from '../types'` line is
 *     type-only and erased today, but if it ever degrades to a bare
 *     side-effect import it cannot resolve from the tmp dir — it is stripped
 *     defensively;
 *   - the three runtime UI imports are rewritten to a sibling stub module.
 *
 * Like sparkline.test.mjs, the tmp dir is created INSIDE web/ (not
 * os.tmpdir()) because the emitted module imports react/jsx-runtime — a bare
 * npm specifier Node can only resolve by walking up to web/node_modules. The
 * emitted files are named *.mjs (never *.test.mjs) so `node --test` cannot
 * pick them up, and cleanup runs in a finally block so a failed import never
 * litters the working tree.
 *
 * Honest limitation (same as the precedent): asserting on the returned element
 * tree pins what the component RETURNS, not what a browser paints. The clamp
 * itself is plain logic over `config`, so it is pinned exactly; only CSS
 * painting semantics are out of reach.
 *
 * The component itself is NOT modified — characterisation, per the ticket.
 *
 * Run: node attentionClamp.test.mjs   (or: npm test, from web/)
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const sectionPath = resolve(
  __dirname,
  'src/components/settings/sections/AttentionThresholdsSection.tsx',
);

// --- Load the REAL section (TSX -> ESM via the OXC transform Vite bundles) ----

// Identity-stub the surrounding UI atoms. The section only uses them as JSX
// types, so their return values never matter here — walking .props of the
// elements the jsx runtime builds is the whole interaction surface.
const STUB_MODULE = `
export function Input(props) { return { stub: 'Input', props }; }
export function Label(props) { return { stub: 'Label', props }; }
export function SettingsSection(props) { return { stub: 'SettingsSection', props }; }
// WARDEN-1276 — the per-row reset-to-default affordance the section now renders
// beside each threshold Label. Stubbed like the other UI atoms: it is pure
// presentation over the same \`config\`/\`setConfig\` this suite already drives,
// and the clamp behaviour under test never reads it.
export function ConfigResetToDefaultButton(props) { return { stub: 'ConfigResetToDefaultButton', props }; }
`;

let src = readFileSync(sectionPath, 'utf8');
// Trap 1: strip the type-only '../types' import — erased by the transform
// today, but if it degrades to a bare side-effect import it cannot resolve
// from the tmp dir. Matches only imports whose bindings are all `type`-only.
src = src.replace(/^import\s*\{\s*type\s[^}]*\}\s*from\s*['"][^'"]*['"];\s*$\n?/gm, '');
// Trap 2: rewrite the three runtime UI imports to the sibling stub module.
// Quote-agnostic (backreference) so a source-side or transform-side quote
// style change cannot defeat the rewrite.
src = src
  .replace(/from\s+(['"])@\/components\/ui\/input\1/g, "from './ui-stubs.mjs'")
  .replace(/from\s+(['"])@\/components\/ui\/label\1/g, "from './ui-stubs.mjs'")
  .replace(/from\s+(['"])\.\.\/SettingsSection\1/g, "from './ui-stubs.mjs'")
  // WARDEN-1276 — the reset-to-default affordance (a real runtime import).
  .replace(/from\s+(['"])\.\.\/rows\/ResetToDefaultButton\1/g, "from './ui-stubs.mjs'");

const { code } = await transformWithOxc(src, sectionPath, {});

// Inside web/ (NOT os.tmpdir) so the bare react/jsx-runtime specifier resolves
// via web/node_modules.
const tmpDir = mkdtempSync(join(__dirname, 'warden-attention-clamp-test-'));
let mod;
let stubs;
try {
  writeFileSync(join(tmpDir, 'ui-stubs.mjs'), STUB_MODULE);
  const tmpFile = join(tmpDir, 'AttentionThresholdsSection.mjs');
  writeFileSync(tmpFile, code);
  mod = await import(tmpFile);
  // Same absolute path => same module instance the component closed over, so
  // `el.type === stubs.Input` is a true identity check on the wiring.
  stubs = await import(join(tmpDir, 'ui-stubs.mjs'));
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
const { AttentionThresholdsSection } = mod;
const { Input: InputStub } = stubs;

// --- Tree-walking helpers -----------------------------------------------------

// Depth-first over elements, arrays, and flattened children. Strings, numbers,
// booleans and null/undefined (the `{cond && <el/>}` false legs) are skipped.
function walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(walk);
  return [node, ...walk(node.props && node.props.children)];
}

// The <Input id="..."> for one of the two threshold fields, with wiring asserts
// baked in: it must exist and it must be the REAL section's Input import.
function inputById(root, id) {
  const found = walk(root).find((el) => el.props && el.props.id === id);
  assert.ok(found, `<Input id="${id}"> must render`);
  assert.equal(found.type, InputStub, `id="${id}" must be an <Input>, not another element`);
  return found;
}

// Render the section with a recording setConfig and the pair under test.
// One sibling field (hosts) rides along so spread-preservation is assertable.
const configOf = (warning, critical) => ({
  hosts: ['alpha', 'beta'],
  healthWarningThresholdMin: warning,
  healthCriticalThresholdMin: critical,
});

function render(warning, critical) {
  const calls = [];
  const root = AttentionThresholdsSection({
    config: configOf(warning, critical),
    setConfig: (next) => calls.push(next),
    hidden: false,
  });
  return { root, calls };
}

const blurWarning = (root) => inputById(root, 'healthWarningThresholdMin').props.onBlur();
const blurCritical = (root) => inputById(root, 'healthCriticalThresholdMin').props.onBlur();

// --- The tests ----------------------------------------------------------------

describe('harness — the REAL section renders through the stubbed UI atoms', () => {
  it('renders both threshold Inputs, number-typed, advertising the min the clamp mirrors', () => {
    const { root } = render(7, 42);
    for (const id of ['healthWarningThresholdMin', 'healthCriticalThresholdMin']) {
      const el = inputById(root, id);
      assert.equal(el.props.type, 'number');
      assert.equal(el.props.min, '1', 'the advertised min IS the clamp floor');
      assert.equal(el.props.step, '1');
    }
  });

  it("passes the current values through (`?? ''` — null renders empty, not 'null')", () => {
    const { root } = render(7, 42);
    assert.equal(inputById(root, 'healthWarningThresholdMin').props.value, 7);
    assert.equal(inputById(root, 'healthCriticalThresholdMin').props.value, 42);
    const empty = render(null, null).root;
    assert.equal(inputById(empty, 'healthWarningThresholdMin').props.value, '');
    assert.equal(inputById(empty, 'healthCriticalThresholdMin').props.value, '');
  });

  it('onChange feeds the clamp numbers: digits parse to an int, empty string becomes null', () => {
    // The clamp composes over onChange's output, so pin the seam that keeps
    // its input numeric: Math.max over a string would compare lexicographically.
    const { root, calls } = render(5, 30);
    inputById(root, 'healthWarningThresholdMin').props.onChange({ target: { value: '12' } });
    assert.equal(calls.length, 1);
    assert.strictEqual(calls[0].healthWarningThresholdMin, 12, 'parseInt, not the raw string');
    inputById(root, 'healthCriticalThresholdMin').props.onChange({ target: { value: '' } });
    assert.equal(calls.length, 2);
    assert.strictEqual(calls[1].healthCriticalThresholdMin, null, 'cleared field = use-the-default');
  });
});

describe('warning field — the floor (WARDEN-925: an out-of-range value must not survive this blur)', () => {
  it('0 with no critical set clamps UP to 1 in exactly one setConfig', () => {
    const { root, calls } = render(0, null);
    blurWarning(root);
    assert.equal(calls.length, 1, 'a single composed setConfig');
    assert.deepEqual(
      calls[0],
      { ...configOf(0, null), healthWarningThresholdMin: 1 },
      'the patch is the full config spread with only the warning changed',
    );
  });

  it('a negative warning clamps to 1 even when a non-binding critical is set', () => {
    const { root, calls } = render(-9, 30);
    blurWarning(root);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].healthWarningThresholdMin, 1, 'floored, not clamped UP toward critical');
  });

  it('null (the use-the-default path) passes through unclamped — no setConfig at all', () => {
    // A clamp must never turn "default" into a number: null means the backend
    // applies its own default (5), and this blur leaves it alone.
    const { root, calls } = render(null, 30);
    blurWarning(root);
    assert.equal(calls.length, 0);
  });

  it('an in-range, well-ordered warning is left untouched — no spurious dirty state', () => {
    const { root, calls } = render(5, 30);
    blurWarning(root);
    assert.equal(calls.length, 0, 'next === w must not rewrite the field');
  });
});

describe('warning field — the pair-ordering clamp (WARDEN-374: warning <= critical)', () => {
  it('a warning exceeding the critical clamps DOWN to it, one setConfig, siblings preserved', () => {
    const { root, calls } = render(10, 5);
    blurWarning(root);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0],
      { ...configOf(10, 5), healthWarningThresholdMin: 5 },
      'warning clamped down to critical; the critical value itself and the sibling fields ride through the spread',
    );
  });

  it('warning === critical is legal (<=, not <) — no clamp at the boundary', () => {
    const { root, calls } = render(5, 5);
    blurWarning(root);
    assert.equal(calls.length, 0);
  });

  it('no ordering clamp against an UNSET critical — null means default-30, not a bound', () => {
    // The clamp only compares explicitly-set values: a null critical is the
    // use-the-default path, and the blur must not invent a 30 to clamp against.
    const { root, calls } = render(100, null);
    blurWarning(root);
    assert.equal(calls.length, 0);
  });
});

describe('warning field — the floor-FIRST composition (single setConfig, never below the floor)', () => {
  it('clamps down to a transiently sub-1 critical no lower than 1 — Math.max(1, c), not bare c', () => {
    // THE ordering pin: `next = Math.max(1, c)` must re-floor the critical it
    // clamps down to. Degrade it to `next = c` and this blur writes 0 — the
    // exact silently-refused-by-backend value the floor exists to prevent.
    const { root, calls } = render(3, 0);
    blurWarning(root);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].healthWarningThresholdMin, 1, 'clamped toward c=0 but never below the floor');
  });

  it('floor and ordering both fire, composed into ONE setConfig (no stale-closure second read)', () => {
    // w=0 needs the floor; c=0 then needs the ordering clamp. Two sequential
    // setConfigs here would be the stale-`config` shape the comment warns
    // about — the call count is the pin.
    const { root, calls } = render(0, 0);
    blurWarning(root);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { ...configOf(0, 0), healthWarningThresholdMin: 1 });
  });
});

describe('critical field — the asymmetry (floors itself, never rewrites warning)', () => {
  it('0 clamps UP to 1 in one setConfig that does NOT touch healthWarningThresholdMin', () => {
    // w=5 > resulting c=1: the pair is left INVERTED by design. Rewriting a
    // field the human never touched is worse — the render-time message below
    // fires immediately and the backend crossField guard orders the pair on save.
    const { root, calls } = render(5, 0);
    blurCritical(root);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0],
      { ...configOf(5, 0), healthCriticalThresholdMin: 1 },
      'only the critical field changes; warning stays 5',
    );
  });

  it('a negative critical clamps to 1 (warning null — nothing else to preserve)', () => {
    const { root, calls } = render(null, -4);
    blurCritical(root);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].healthCriticalThresholdMin, 1);
    assert.strictEqual(calls[0].healthWarningThresholdMin, null);
  });

  it('null critical passes through unclamped; an in-range critical is untouched', () => {
    const a = render(5, null);
    blurCritical(a.root);
    assert.equal(a.calls.length, 0, 'null is the use-the-default path');
    const b = render(5, 30);
    blurCritical(b.root);
    assert.equal(b.calls.length, 0, 'no floor to apply, no write');
  });

  it('does NOT order-clamp: blurring critical with an inverted pair writes NOTHING', () => {
    // w=10 > c=3 and the human just left the critical field — the symmetric
    // "fix" would clamp warning down here. This section deliberately refuses:
    // the ordering clamp lives in the WARNING field's blur only. If this test
    // fails, someone made the fields symmetric and deleted the documented
    // asymmetry (see the component comment: "Deliberately does NOT touch
    // healthWarningThresholdMin").
    const { root, calls } = render(10, 3);
    blurCritical(root);
    assert.equal(calls.length, 0, 'critical blur must not rewrite the warning field');
  });
});

describe('render-time messages — the asymmetry is surfaced, not silent', () => {
  // The mitigation the asymmetry relies on: leaving the pair inverted after
  // critical's floor is only acceptable because the section SAYS so, in-product,
  // at the moment the inversion exists.
  const paragraphs = (root) =>
    walk(root)
      .filter((el) => el.type === 'p')
      .map((el) =>
        (Array.isArray(el.props.children) ? el.props.children : [el.props.children])
          .filter((c) => typeof c === 'string' || typeof c === 'number')
          .join(''),
      );

  it('an inverted pair renders the ordering message naming the critical it will cap to', () => {
    const texts = paragraphs(render(5, 1).root);
    assert.ok(
      texts.some((t) => t.includes('Warning must come before Critical') && t.includes('capped to 1 min')),
      `expected the ordering message, got: ${JSON.stringify(texts)}`,
    );
  });

  it('a sub-1 warning renders the floor message; a clean pair renders neither', () => {
    const floored = paragraphs(render(0, 30).root);
    assert.ok(
      floored.some((t) => t.includes('Must be at least 1')),
      'the floor message renders while the sub-1 value is still on screen',
    );
    const clean = paragraphs(render(5, 30).root);
    assert.ok(
      !clean.some((t) => t.includes('Must be at least 1') || t.includes('Warning must come before')),
      `a well-ordered in-range pair must render no complaint, got: ${JSON.stringify(clean)}`,
    );
  });
});

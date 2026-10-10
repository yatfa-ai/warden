import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the Settings → Telemetry "What telemetry sends" panel
 * right-click menus (WARDEN-1722), in the style of gitListHeadersContextMenu.test.mjs.
 * No front-end DOM runner exists, so "right-click opens the themed menu" is verified
 * live; here each test names the SOURCE property it checks: which element each trigger
 * wraps, the exact item labels, the copy payloads, and that no bare navigator.clipboard
 * is used.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'components', 'TelemetryTransparency.tsx');
const text = fs.readFileSync(SRC, 'utf8');

function between(startMarker, endMarker, from = 0) {
  const s = text.indexOf(startMarker, from);
  assert.ok(s !== -1, `marker not found: ${startMarker}`);
  const e = text.indexOf(endMarker, s + startMarker.length);
  assert.ok(e !== -1, `end marker not found: ${endMarker}`);
  return text.slice(s, e);
}
function element(src, tag) {
  const open = src.indexOf(`<${tag}`);
  assert.ok(open !== -1, `<${tag}> not found`);
  const bodyStart = src.indexOf('>', open) + 1;
  const close = src.indexOf(`</${tag}>`, bodyStart);
  assert.ok(close !== -1, `</${tag}> not found`);
  return src.slice(bodyStart, close);
}
const triggerOf = (m) => element(m, 'ContextMenuTrigger');
const contentOf = (m) => element(m, 'ContextMenuContent');
const itemLabels = (content) => [...content.matchAll(/>\s*([^<>{}]+?)\s*<\/ContextMenuItem>/g)].map((x) => x[1]);

const chipMenu = between('function FieldChip', '/** One row in a tier-summary card');
const redactionMenu = between('<ContextMenu key={`${c.path}', '</ContextMenu>');
const payloadMenu = between('<ContextMenu>\n              <ContextMenuTrigger asChild>\n                <pre className="max-h-72', '</ContextMenu>');
const sampleMenu = between('<ContextMenu>\n              <ContextMenuTrigger asChild>\n                <pre className="max-h-64', '</ContextMenu>');

describe('TelemetryTransparency declares themed context menus (WARDEN-1722)', () => {
  it('declares exactly four <ContextMenuTrigger asChild> triggers', () => {
    assert.strictEqual((text.match(/<ContextMenuTrigger asChild>/g) || []).length, 4);
  });

  it('uses copyWithToast and never a bare navigator.clipboard', () => {
    assert.match(text, /import \{ copyWithToast \} from '@\/lib\/clipboardToast';/);
    assert.doesNotMatch(text, /navigator\.clipboard/);
  });

  it('FieldChip wraps its <code> once and copies the string child', () => {
    assert.match(chipMenu, /function FieldChip\(\{ children \}: \{ children: string \}\)/);
    assert.ok(triggerOf(chipMenu).trim().startsWith('<code'));
    assert.deepStrictEqual(itemLabels(contentOf(chipMenu)), ['Copy field name']);
    assert.match(contentOf(chipMenu), /copyWithToast\(children\)/);
  });

  it('redaction <li> row copies the path and "label — path"', () => {
    assert.ok(triggerOf(redactionMenu).trim().startsWith('<li '));
    assert.deepStrictEqual(itemLabels(contentOf(redactionMenu)), ['Copy field path', 'Copy change']);
    assert.match(contentOf(redactionMenu), /copyWithToast\(c\.path\)/);
    assert.match(contentOf(redactionMenu), /copyWithToast\(`\$\{cb\.label\} — \$\{c\.path\}`\)/);
  });

  it('payload <pre> copies the exact pretty-printed payload and its compact byte size', () => {
    assert.ok(triggerOf(payloadMenu).trim().startsWith('<pre '));
    assert.deepStrictEqual(itemLabels(contentOf(payloadMenu)), ['Copy exact payload', 'Copy payload size']);
    assert.match(contentOf(payloadMenu), /copyWithToast\(payloadPretty\)/);
    assert.match(contentOf(payloadMenu), /TextEncoder\(\)\.encode\(JSON\.stringify\(preview\.payload\)\)\.length/);
  });

  it('payload render and payload copy derive from the SAME pretty-printed expression', () => {
    const decl = text.match(/const payloadPretty = useMemo\(\(\) => (JSON\.stringify\(preview\.payload, null, 2\)),/);
    assert.ok(decl, 'payloadPretty must be JSON.stringify(preview.payload, null, 2)');
    assert.match(triggerOf(payloadMenu), /\{payloadPretty\}/);
    // The pretty-print expression is computed exactly once.
    assert.strictEqual((text.match(/JSON\.stringify\(preview\.payload, null, 2\)/g) || []).length, 1);
  });

  it('sample <pre> copies the pretty-printed sample event', () => {
    assert.ok(triggerOf(sampleMenu).trim().startsWith('<pre '));
    assert.deepStrictEqual(itemLabels(contentOf(sampleMenu)), ['Copy sample event']);
    assert.match(contentOf(sampleMenu), /copyWithToast\(JSON\.stringify\(SAMPLE_ERROR_EVENT, null, 2\)\)/);
  });
});

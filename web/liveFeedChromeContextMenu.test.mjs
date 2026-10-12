import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the LiveFeedChrome context menu (WARDEN-1759,
 * roadmap WARDEN-362). No front-end DOM runner exists, so these pin properties
 * of the SOURCE; "right-click opens the menu" is verified live.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(HERE, 'src', 'components', 'LiveFeedChrome.tsx'), 'utf8');
const content = text.slice(text.indexOf('<ContextMenuContent>'), text.indexOf('</ContextMenuContent>'));

describe('LiveFeedChrome declares a themed context menu (WARDEN-1759)', () => {
  it('has exactly one asChild trigger wrapping the header, with the failure strip outside it', () => {
    assert.strictEqual(text.split('<ContextMenuTrigger asChild>').length - 1, 1);
    const triggerBody = text.slice(text.indexOf('<ContextMenuTrigger asChild>'), text.indexOf('</ContextMenuTrigger>'));
    assert.ok(!triggerBody.includes('role="status"'));
    assert.ok(text.indexOf('</ContextMenu>') < text.indexOf('role="status"'));
  });

  it('binds Pause/Resume and Refresh to the same handlers as the buttons', () => {
    assert.match(content, /onSelect=\{\(\) => setIsLive\(\(v\) => !v\)\}/);
    assert.match(content, /isLive \? 'Pause live updates' : 'Resume live updates'/);
    assert.match(content, /disabled=\{loading \|\| refreshing\} onSelect=\{\(\) => refresh\(\)\}/);
  });

  it('copies host/agent filter labels and the shared stats line', () => {
    assert.match(content, /copyWithToast\(hostFilter === 'all' \? 'All Hosts' : hostFilter\)/);
    assert.match(content, /copyWithToast\(agentFilter === 'all' \? 'All Agents' : agentFilter\)/);
    assert.match(content, /copyWithToast\(statsLine\)/);
    assert.match(text, /<div className="text-xs text-muted-foreground">\{statsLine\}<\/div>/);
  });

  it('has no hand-rolled onContextMenu handler (WARDEN-926)', () => {
    assert.ok(!text.includes('onContextMenu='));
  });
});

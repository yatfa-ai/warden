// Unit tests for the application-menu template (WARDEN-1280).
//
// electron/menu-template.cjs holds the SHAPE of the menu that replaces Electron's
// stock template — which items exist, what each one leads to, and how the macOS
// and Windows/Linux variants differ. main.cjs can't be exercised under
// `node --test` (it requires electron), so the shape lives in an electron-free
// module and is asserted here, the same split as window-state.cjs /
// web/window-state.test.mjs.
//
// The contract these tests exist to hold is the ticket's whole point: EVERY ITEM
// LEADS SOMEWHERE REAL. That is checkable mechanically — an item is either a
// platform-standard role (which Electron dispatches to the focused webContents)
// or it carries a registered click handler; nothing points at an external URL;
// and the three stock items that led nowhere (New Window, "About Electron",
// electronjs.org links) are gone.
//
// Run: node menu-template.test.mjs   (or: npm test, from web/)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { buildMenuTemplate, flattenMenuItems, windowNeedsRestore, REACHABILITY_EXEMPT } = require('../electron/menu-template.cjs');
const { readFileSync } = require('node:fs');

const PLATFORMS = ['darwin', 'win32', 'linux'];

// Roles Electron 43 defines but does NOT execute: their entry in the bundled
// `roleList` (lib/browser/api/menu-item-roles.ts, verified against the shipped
// node_modules/electron/dist/electron binary) carries a `label` and nothing
// else — no `appMethod`, no `windowMethod`, no `webContentsMethod`, no
// `submenu`. `MenuItem#execute()` reads exactly those three method fields and
// returns false when none is present, and a role-only item has no `click` of
// its own to fall back to, so CLICKING ONE DOES NOTHING.
//
// On macOS that is deliberate rather than broken: `execute()` is gated on
// `(!isDarwin || roleList[role].nonNativeMacOSRole)`, so these roles bail out on
// darwin *by design* and the item is handed to AppKit, which implements it
// natively. Off macOS nobody picks them up — an item with one of these roles and
// no click handler renders enabled and inert. That is the "dead item" this
// suite exists to catch, and a NAME check (`typeof item.role === 'string'`)
// cannot see it: the name is perfectly valid, it just does not run.
//
// `help` and `window` appear here because they are inert as LEAVES; used as
// container roles on a menu that carries its own submenu (as `help` is here)
// they are fine, which is why the check below runs on leaves only.
const INERT_ROLES = new Set([
  'front', 'help', 'hide', 'hideOthers', 'services', 'recentDocuments',
  'clearRecentDocuments', 'showSubstitutions', 'toggleSmartQuotes',
  'toggleSmartDashes', 'toggleTextReplacement', 'startSpeaking', 'stopSpeaking',
  'unhide', 'window', 'zoom',
]);

/** A template built with every handler recorded, so clicks can be traced. */
function buildWithSpies(platform) {
  const calls = [];
  const spy = (name) => () => calls.push(name);
  const template = buildMenuTemplate({
    platform,
    appName: 'Yatfa Warden',
    handlers: {
      openSettings: spy('openSettings'),
      showAbout: spy('showAbout'),
      showStallDiagnostics: spy('showStallDiagnostics'),
      openDataFolder: spy('openDataFolder'),
      toggleMaximize: spy('toggleMaximize'),
      selectAll: spy('selectAll'),
    },
  });
  return { template, calls };
}

function topLevelLabels(template) {
  return template.map((m) => m.label);
}

function findItem(template, label) {
  return flattenMenuItems(template).find((i) => i.label === label);
}

// ---------------------------------------------------------------------------
// The core contract: no dead items, on any platform.
// ---------------------------------------------------------------------------

for (const platform of PLATFORMS) {
  test(`[${platform}] every leaf item leads somewhere real (an EXECUTABLE role or a handler)`, () => {
    const { template } = buildWithSpies(platform);
    const items = flattenMenuItems(template);
    const isMac = platform === 'darwin';
    assert.ok(items.length > 0, 'the template has items');
    for (const item of items) {
      if (typeof item.click === 'function') continue;
      const role = typeof item.role === 'string' ? item.role : null;
      assert.ok(
        role,
        `menu item ${JSON.stringify(item.label ?? item)} has neither a role nor a click handler — it is a dead item`,
      );
      // EXECUTABILITY, not spelling. Off macOS a role with no method in
      // Electron 43's roleList is as dead as a typo'd one; on macOS AppKit
      // implements it, so it is legitimate there.
      assert.ok(
        isMac || !INERT_ROLES.has(role),
        `menu item ${JSON.stringify(item.label ?? role)} relies on role '${role}', which Electron 43 does not execute on ${platform} ` +
          '(no appMethod/windowMethod/webContentsMethod) and which no native platform handler picks up off macOS — it is a dead item',
      );
    }
  });

  test(`[${platform}] no item points at an external URL`, () => {
    const { template } = buildWithSpies(platform);
    // Serializing the whole template catches a URL wherever it hides — a `url`
    // property, a label, or a submenu we forgot to walk.
    const serialized = JSON.stringify(template, (_k, v) => (typeof v === 'function' ? '[fn]' : v));
    assert.ok(!/https?:\/\//i.test(serialized), 'template contains an http(s) URL');
    assert.ok(!/electronjs\.org/i.test(serialized), 'template references electronjs.org');
    for (const item of flattenMenuItems(template)) {
      assert.equal(item.url, undefined, `item ${item.label} carries a url property`);
    }
  });

  test(`[${platform}] the harmful/dead stock items are gone`, () => {
    const { template } = buildWithSpies(platform);
    const labels = flattenMenuItems(template).map((i) => String(i.label ?? ''));
    const roles = flattenMenuItems(template).map((i) => String(i.role ?? ''));
    // File > New Window: since WARDEN-1346 the app holds a single-instance
    // lock (a second Electron launch quits and raises the first instance), and
    // a second window inside ONE process is still not a supported shape here —
    // so New Window stays gone on its own merits.
    assert.ok(!labels.some((l) => /new window/i.test(l)), 'New Window is present');
    assert.ok(!roles.includes('newWindow'), 'the newWindow role is present');
    // "About Electron" — the stock About names the wrong application.
    assert.ok(!labels.some((l) => /about electron/i.test(l)), '"About Electron" is present');
    // The stock Help menu's learn-more / documentation / community links.
    assert.ok(
      !labels.some((l) => /learn more|documentation|community|search issues|report issue/i.test(l)),
      'a stock Help link is present',
    );
  });

  test(`[${platform}] the platform-standard roles the stock template provided are kept`, () => {
    const { template } = buildWithSpies(platform);
    const roles = new Set(flattenMenuItems(template).map((i) => i.role).filter(Boolean));
    // Edit — why Copy/Paste/Cut/Undo/Redo work inside Settings text fields.
    // Select All is deliberately ABSENT from this list: since WARDEN-1356 it is
    // a wired click item, not a role (the role is inert on the agent-pane
    // surface) — asserted by the EFFECT rung below.
    for (const r of ['undo', 'redo', 'cut', 'copy', 'paste']) {
      assert.ok(roles.has(r), `edit role '${r}' missing`);
    }
    assert.ok(!roles.has('selectAll'), "edit Select All must stay a wired click item, not the role:'selectAll' that is inert on the agent-pane surface");
    // View — why Reload reloads the app view.
    for (const r of ['reload', 'forceReload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']) {
      assert.ok(roles.has(r), `view role '${r}' missing`);
    }
    // Window. `minimize` is executable everywhere (it carries a windowMethod).
    // `zoom` is NOT: it is a macOS-only, AppKit-implemented role, so it is
    // asserted on darwin and must be ABSENT elsewhere — off macOS the Window
    // menu carries a genuinely-wired maximize/restore item instead
    // (WARDEN-1313).
    assert.ok(roles.has('minimize'), "window role 'minimize' missing");
    if (platform === 'darwin') {
      assert.ok(roles.has('zoom'), "window role 'zoom' missing on darwin");
    } else {
      assert.ok(!roles.has('zoom'), `inert role 'zoom' present on ${platform}`);
    }
    // Quit is reachable on every platform (app menu on macOS, File elsewhere).
    assert.ok(roles.has('quit'), 'quit role missing');
  });

  test(`[${platform}] Settings… is present with the platform-standard accelerator and opens Settings`, () => {
    const { template, calls } = buildWithSpies(platform);
    const settings = findItem(template, 'Settings…');
    assert.ok(settings, 'Settings… item missing');
    assert.equal(settings.accelerator, 'CmdOrCtrl+,');
    settings.click();
    assert.deepEqual(calls, ['openSettings']);
  });

  test(`[${platform}] the diagnostics items are present and wired`, () => {
    const { template, calls } = buildWithSpies(platform);
    const stalls = findItem(template, 'Stall Diagnostics…');
    const folder = findItem(template, 'Open Data Folder');
    assert.ok(stalls, 'Stall Diagnostics… item missing');
    assert.ok(folder, 'Open Data Folder item missing');
    stalls.click();
    folder.click();
    assert.deepEqual(calls, ['showStallDiagnostics', 'openDataFolder']);
  });

  test(`[${platform}] the version is reachable from the menu`, () => {
    const { template } = buildWithSpies(platform);
    const items = flattenMenuItems(template);
    // macOS renders the About PANEL through role:'about' (fed by
    // setAboutPanelOptions in main); Windows/Linux take an explicit item whose
    // click opens the native dialog. Either way there is exactly one route.
    const aboutRoutes = items.filter(
      (i) => i.role === 'about' || /^About /.test(String(i.label ?? '')),
    );
    assert.equal(aboutRoutes.length, 1, 'expected exactly one About route');
  });
}

// Every role name Electron 43 accepts (MenuItemConstructorOptions['role'] in
// node_modules/electron/electron.d.ts). A typo'd role is not a build error — it
// is a SILENTLY DEAD item, exactly what this ticket removes — so the "leads
// somewhere real" check above is only as strong as this list.
const VALID_ROLES = new Set([
  'undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll',
  'reload', 'forceReload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut',
  'toggleSpellChecker', 'togglefullscreen', 'window', 'minimize', 'close', 'help',
  'about', 'services', 'hide', 'hideOthers', 'unhide', 'quit', 'showSubstitutions',
  'toggleSmartQuotes', 'toggleSmartDashes', 'toggleTextReplacement', 'startSpeaking',
  'stopSpeaking', 'zoom', 'front', 'appMenu', 'fileMenu', 'editMenu', 'viewMenu',
  'shareMenu', 'recentDocuments', 'toggleTabBar', 'selectNextTab', 'selectPreviousTab',
  'showAllTabs', 'mergeAllWindows', 'clearRecentDocuments', 'moveTabToNewWindow',
  'windowMenu',
]);

for (const platform of PLATFORMS) {
  test(`[${platform}] every role is one Electron actually recognizes`, () => {
    const { template } = buildWithSpies(platform);
    // Walk the RAW template, not just the leaves: `role: 'help'` sits on the Help
    // menu itself, which flattenMenuItems descends past.
    const walk = (items) => {
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.role === 'string') {
          assert.ok(VALID_ROLES.has(item.role), `unknown role '${item.role}' on ${item.label ?? '(unlabelled)'}`);
        }
        if (Array.isArray(item.submenu)) walk(item.submenu);
      }
    };
    walk(template);
  });
}

// ---------------------------------------------------------------------------
// Platform variants — the two shapes differ only where the platform conventions
// genuinely differ, and the tests pin exactly where.
// ---------------------------------------------------------------------------

test('[darwin] the app menu carries the macOS conventions and holds Settings', () => {
  const { template, calls } = buildWithSpies('darwin');
  assert.equal(template[0].label, 'Yatfa Warden', 'first menu is the app menu');
  const appRoles = template[0].submenu.map((i) => i.role).filter(Boolean);
  for (const r of ['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit']) {
    assert.ok(appRoles.includes(r), `macOS app-menu role '${r}' missing`);
  }
  // Preferences belongs in the app menu on macOS, not File.
  const settingsInApp = template[0].submenu.find((i) => i.label === 'Settings…');
  assert.ok(settingsInApp, 'Settings… is not in the macOS app menu');
  settingsInApp.click();
  assert.deepEqual(calls, ['openSettings']);
  const file = template.find((m) => m.label === 'File');
  assert.ok(!file.submenu.some((i) => i.label === 'Settings…'), 'Settings… duplicated into File on macOS');
});

for (const platform of ['win32', 'linux']) {
  test(`[${platform}] there is no macOS app menu; Settings + Quit live in File`, () => {
    const { template } = buildWithSpies(platform);
    assert.equal(template[0].label, 'File', 'first menu should be File off macOS');
    assert.ok(!topLevelLabels(template).includes('Yatfa Warden'), 'app menu present off macOS');
    const file = template.find((m) => m.label === 'File');
    assert.ok(file.submenu.some((i) => i.label === 'Settings…'), 'Settings… missing from File');
    assert.ok(file.submenu.some((i) => i.role === 'quit'), 'quit missing from File');
  });

  test(`[${platform}] About lives in Help and opens the injected dialog`, () => {
    const { template, calls } = buildWithSpies(platform);
    const help = template.find((m) => m.label === 'Help');
    const about = help.submenu.find((i) => i.label === 'About Yatfa Warden');
    assert.ok(about, 'About item missing from Help');
    about.click();
    assert.deepEqual(calls, ['showAbout']);
    // role:'about' renders nothing off macOS — an item relying on it would be dead.
    assert.ok(
      !flattenMenuItems(template).some((i) => i.role === 'about'),
      `role:'about' used on ${platform}, where it renders no panel`,
    );
  });
}

for (const platform of ['win32', 'linux']) {
  test(`[${platform}] Window > maximize/restore is genuinely wired, not the inert 'zoom' role`, () => {
    const { template, calls } = buildWithSpies(platform);
    const windowMenu = template.find((m) => m.label === 'Window');
    assert.ok(windowMenu, 'Window menu missing');
    const items = flattenMenuItems(windowMenu.submenu);
    // Electron 43's `zoom` has no method off macOS: an item carrying it would
    // render, be enabled, and do nothing.
    assert.ok(!items.some((i) => i.role === 'zoom'), `role:'zoom' used on ${platform}, where it executes nothing`);
    const maxItem = items.find((i) => /maximi[sz]e|restore/i.test(String(i.label ?? '')));
    assert.ok(maxItem, 'no maximize/restore item in the Window menu');
    assert.equal(typeof maxItem.click, 'function', 'the maximize/restore item carries no click handler');
    maxItem.click();
    assert.deepEqual(calls, ['toggleMaximize'], 'the maximize/restore item does not call the injected handler');
  });
}

test("[darwin] Window > Zoom stays the native role:'zoom' item", () => {
  const { template } = buildWithSpies('darwin');
  const windowMenu = template.find((m) => m.label === 'Window');
  const items = flattenMenuItems(windowMenu.submenu);
  assert.ok(items.some((i) => i.role === 'zoom'), "role:'zoom' missing from the macOS Window menu");
  // macOS must NOT take the injected handler — AppKit already implements zoom.
  assert.ok(
    !items.some((i) => /maximi[sz]e|restore/i.test(String(i.label ?? ''))),
    'a maximize/restore item leaked into the macOS Window menu',
  );
});

test('every platform exposes the same top-level menus apart from the macOS app menu', () => {
  const mac = topLevelLabels(buildWithSpies('darwin').template);
  const win = topLevelLabels(buildWithSpies('win32').template);
  const linux = topLevelLabels(buildWithSpies('linux').template);
  assert.deepEqual(win, linux, 'win32 and linux menus should be identical');
  assert.deepEqual(mac, ['Yatfa Warden', ...win]);
});

// ---------------------------------------------------------------------------
// Defensive construction — main injects the handlers, so the module must not
// assume they are there (a missing one must not produce a THROWING item, which
// would be worse than a dead one).
// ---------------------------------------------------------------------------

test('missing handlers degrade to safe no-op clicks rather than throwing', () => {
  for (const platform of PLATFORMS) {
    const template = buildMenuTemplate({ platform });
    for (const item of flattenMenuItems(template)) {
      if (typeof item.click === 'function') {
        assert.doesNotThrow(() => item.click(), `clicking ${item.label} threw with no handlers injected`);
      }
    }
  }
});

test('buildMenuTemplate defaults appName and platform without arguments', () => {
  const template = buildMenuTemplate();
  assert.ok(Array.isArray(template) && template.length > 0);
  assert.ok(flattenMenuItems(template).some((i) => i.label === 'Settings…'));
});

test('flattenMenuItems skips separators and descends into submenus', () => {
  const flat = flattenMenuItems([
    { label: 'A', submenu: [{ label: 'A1', role: 'copy' }, { type: 'separator' }, { label: 'A2', click: () => {} }] },
    { type: 'separator' },
    { label: 'B', role: 'quit' },
  ]);
  assert.deepEqual(flat.map((i) => i.label), ['A1', 'A2', 'B']);
});

// ---------------------------------------------------------------------------
// REACHABILITY, not just SHAPE (WARDEN-1333).
//
// With close-to-tray ON the window is HIDDEN but ALIVE (the close intercept
// hide()s it and window-all-closed never fires), and on macOS the application
// menu bar stays present and fully clickable in exactly that state. Every test
// above proves a menu item HAS an executable action; none of them can see that
// an action can run against an INVISIBLE window — Settings pushed into a
// hidden window opens where nobody can see it, and a dialog parented to a
// hidden window sits open awaiting a click with zero visible windows.
//
// The rule — an action that targets the main window must first ensure the
// window is visible — lives in menu-template.cjs (electron-free, like the
// template itself): buildMenuTemplate wraps every injected action so it runs
// main's ensureMainWindowVisible() BEFORE acting, and openDataFolder is the
// one deliberate exemption (its destination is the OS file manager, not the
// app window). The tests below pin the ordering, the exemption, and — because
// main.cjs cannot be required under node --test — main.cjs's actual wiring of
// the guard, so a revert to the unwired behaviour of any one of them turns the
// suite RED rather than shipping a menu that is usable only in the states the
// owner is never in.
// ---------------------------------------------------------------------------

/** buildWithSpies + an ensureMainWindowVisible spy recording its position in the click order. */
function buildWithOrder(platform) {
  const order = [];
  const template = buildMenuTemplate({
    platform,
    appName: 'Yatfa Warden',
    handlers: {
      ensureMainWindowVisible: () => order.push('ensure'),
      openSettings: () => order.push('openSettings'),
      showAbout: () => order.push('showAbout'),
      showStallDiagnostics: () => order.push('showStallDiagnostics'),
      openDataFolder: () => order.push('openDataFolder'),
      toggleMaximize: () => order.push('toggleMaximize'),
      selectAll: () => order.push('selectAll'),
    },
  });
  return { template, order };
}

// [menu item label, injected handler, platforms the item exists on]
const WINDOW_TARGETING_ITEMS = [
  ['Settings…', 'openSettings', ['darwin', 'win32', 'linux']],
  ['Stall Diagnostics…', 'showStallDiagnostics', ['darwin', 'win32', 'linux']],
  ['About Yatfa Warden', 'showAbout', ['win32', 'linux']],
  ['Maximize / Restore', 'toggleMaximize', ['win32', 'linux']],
  // WARDEN-1356 — Select All acts on the renderer's focus, so it inherits the
  // reach wrap like every other window-targeting item. This is the STATED
  // decision the ticket asked for: the wrap is not a silent inheritance of
  // WARDEN-1333 plumbing, it is asserted here on every platform — restoring
  // the window first is what makes a select-all click reach a visible surface
  // when the app sits hidden to the tray.
  ['Select All', 'selectAll', ['darwin', 'win32', 'linux']],
];

for (const platform of PLATFORMS) {
  test(`[${platform}] every window-targeting item ensures the window is visible BEFORE it acts`, () => {
    const { template, order } = buildWithOrder(platform);
    for (const [label, handler, platforms] of WINDOW_TARGETING_ITEMS) {
      if (!platforms.includes(platform)) continue;
      order.length = 0;
      const item = findItem(template, label);
      assert.ok(item, `${label} is missing from the template`);
      item.click();
      assert.deepEqual(
        order,
        ['ensure', handler],
        `${label} acted without first ensuring the main window is visible — ` +
          'while the window is hidden to the tray this click vanishes into an invisible window',
      );
    }
  });

  test(`[${platform}] Open Data Folder does NOT restore the window (deliberate exemption)`, () => {
    const { template, order } = buildWithOrder(platform);
    const folder = findItem(template, 'Open Data Folder');
    assert.ok(folder, 'Open Data Folder is missing');
    folder.click();
    // Its destination is the OS file manager (shell.openPath), which is visible
    // regardless of the app window's state — restoring the window would be a
    // spurious raise the item never promised.
    assert.deepEqual(order, ['openDataFolder'], 'Open Data Folder must stay exempt from the reachability guard');
  });
}

test('the exemption list is exactly the one recorded decision (adding one must be a stated change)', () => {
  assert.deepEqual(
    [...REACHABILITY_EXEMPT.keys()],
    ['openDataFolder'],
    'REACHABILITY_EXEMPT changed — every exemption needs a recorded reason here and in the PR',
  );
});

test('windowNeedsRestore: a hidden-but-alive window needs restoring; visible, destroyed, or absent does not', () => {
  assert.equal(windowNeedsRestore({ isDestroyed: () => false, isVisible: () => false }), true, 'hidden window');
  assert.equal(windowNeedsRestore({ isDestroyed: () => false, isVisible: () => true }), false, 'visible window — no raise, no focus steal');
  assert.equal(windowNeedsRestore({ isDestroyed: () => true, isVisible: () => false }), false, 'destroyed window — nothing to restore');
  assert.equal(windowNeedsRestore(null), false, 'no window');
});

// main.cjs cannot be required under node --test, so its half of the wiring is
// pinned by source assertion. This is the mutation guard's second half: the
// template tests above go RED if a wrap disappears from the template, this one
// goes RED if main.cjs stops supplying the live guard the wrap calls.
test('main.cjs actually wires ensureMainWindowVisible — visibility-gated, through showMainWindow', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

  const wiring = src.match(/function ensureMainWindowVisible\(\) \{[\s\S]*?\n\}/);
  assert.ok(wiring, 'main.cjs no longer defines ensureMainWindowVisible — the menu guard is unwired');
  assert.match(
    wiring[0],
    /windowNeedsRestore\(win\)/,
    'ensureMainWindowVisible must gate on the pure windowNeedsRestore(win) decision',
  );
  assert.match(
    wiring[0],
    /showMainWindow\(\)/,
    'ensureMainWindowVisible must restore through showMainWindow() — the tray-proven restore path',
  );

  const install = src.slice(src.indexOf('function installApplicationMenu'));
  assert.ok(install.length > 0, 'installApplicationMenu is gone from main.cjs');
  const handlersIdx = install.indexOf('handlers: {');
  assert.ok(handlersIdx !== -1, 'installApplicationMenu no longer passes a handlers object to buildMenuTemplate');
  assert.match(
    install.slice(handlersIdx, handlersIdx + 600),
    /ensureMainWindowVisible/,
    'installApplicationMenu must inject ensureMainWindowVisible into buildMenuTemplate — ' +
      'without it the template has nothing to call and every click degrades to the unwired behaviour',
  );
});

// ---------------------------------------------------------------------------
// EFFECT, not just EXECUTABILITY (WARDEN-1356) — the fourth rung of the ladder.
//
// Rung 1 asked whether the item EXISTS and points somewhere (WARDEN-1280).
// Rung 2 asked whether the role EXECUTES at all (WARDEN-1311/1313 — INERT_ROLES).
// Rung 3 asked whether the action REACHES a visible window (WARDEN-1333).
// All three judge the TEMPLATE OBJECT. None can see the SURFACE — and the
// agent pane (xterm) defeats two stock roles that execute flawlessly: xterm
// registers clipboard listeners for copy and paste ONLY (0 `cut`, 0
// `selectall` in web/node_modules/@xterm/xterm/lib/xterm.js) and its helper
// textarea is EMPTY, so webContents.selectAll() and webContents.cut() act on
// an empty element and change nothing. From inside the template, a role that
// executes against a webContents that ignores it is indistinguishable from
// one that works. That is why all 45 pre-WARDEN-1356 tests passed a live
// defect.
//
// The fix cannot live in the template alone — a claim about SURFACE behaviour
// is a live-app fact, and this repo has no front-end DOM runner. So the rung
// pins the WIRING the effect depends on, exactly the WARDEN-1333 pattern of
// source-asserting main.cjs's half:
//
//   Select All — a bare role fires NO DOM event (verified live: zero events
//   at the pane while a real <input> emitted selectionchange/selectstart), so
//   the renderer is structurally blind to the role path. The item is a WIRED
//   click instead: main pushes 'menu:select-all' (the WARDEN-1280 bridge
//   shape) and the renderer routes by REAL DOM focus — the focused pane's
//   term.selectAll(), or document.execCommand('selectAll') for a focused
//   field, which is what keeps Settings working. The template-side half is
//   mutation-checked by construction: reverting the item to a bare
//   `role: 'selectAll'` turns the assertion below RED.
//
//   Cut — the role DOES reach the renderer, as a native DOM cut event at the
//   focused element, so it keeps `role: 'cut'` and the pane claims it in the
//   capture phase (the WARDEN-1338 paste shape), performing the one honest
//   terminal reading: copy the selection to the clipboard, then clear it.
//   That half is pinned by source assertion over PaneTile.tsx and by the pure
//   predicate's own suite (web/terminalEdit.test.mjs).
//
// The Settings constraint is the reason both fixes are gated on target
// identity / real DOM focus (the load-bearing half of the predicate suite):
// these Edit items exist FOR the fields as much as for the pane, and the
// probes showed they work there today.
// ---------------------------------------------------------------------------

for (const platform of PLATFORMS) {
  test(`[${platform}] EFFECT — Edit ▸ Select All is a wired click, not the inert-on-pane bare role`, () => {
    const { template, calls } = buildWithSpies(platform);
    const edit = template.find((m) => m.label === 'Edit');
    assert.ok(edit, 'Edit menu missing');
    const selectAll = flattenMenuItems(edit.submenu).find((i) => i.label === 'Select All');
    assert.ok(
      selectAll,
      'Edit ▸ Select All is missing — the stock role was removed without wiring the replacement',
    );
    // The mutation check the EFFECT rung exists for: a bare `role: 'selectAll'`
    // executes as webContents.selectAll() against xterm's empty helper textarea
    // and changes nothing — selection 0 → 0, verified live three times. The
    // item must carry its own handler so the renderer can route by real focus.
    assert.equal(
      selectAll.role,
      undefined,
      "Edit ▸ Select All reverted to a bare role — role:'selectAll' is inert on the agent-pane surface (xterm's helper textarea is empty; no DOM event fires), so the item must stay WIRED",
    );
    assert.equal(typeof selectAll.click, 'function', 'Select All carries no click handler');
    assert.equal(selectAll.accelerator, 'CmdOrCtrl+A', 'Select All lost the platform accelerator label');
    calls.length = 0;
    selectAll.click();
    assert.deepEqual(
      calls,
      ['selectAll'],
      'Select All must route through the injected handler (main pushes menu:select-all; the renderer routes by real DOM focus)',
    );
  });

  test(`[${platform}] EFFECT — Edit ▸ Cut keeps the role whose DOM event the pane intercepts`, () => {
    const { template } = buildWithSpies(platform);
    const edit = template.find((m) => m.label === 'Edit');
    const cut = flattenMenuItems(edit.submenu).find((i) => i.role === 'cut');
    assert.ok(cut, "Edit ▸ Cut must stay role:'cut' — webContents.cut() dispatches the native cut event the pane claims");
    assert.equal(typeof cut.click, 'undefined', 'Cut must not grow a click handler — its effect is the capture-phase interception');
  });
}

// The renderer half of the EFFECT rung, pinned by source assertion (main.cjs
// cannot be required under node --test, and neither can PaneTile/App — the
// wiring itself is what the mutation check guards).
test('EFFECT — the renderer wiring that gives Select All and Cut their pane effect is present', () => {
  const pane = readFileSync(new URL('./src/components/PaneTile.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('./src/App.tsx', import.meta.url), 'utf8');

  // CUT: the capture-phase claim, the shared predicate, and the honest
  // copy-then-clear route. (web/terminalEdit.test.mjs holds the predicate's
  // truth table; this pins that PaneTile actually consults it.)
  const cutHandler = pane.match(/const onNativeCutCapture = \(e: ClipboardEvent\) => \{[\s\S]*?\n    \};/);
  assert.ok(cutHandler, "the WARDEN-1356 cut capture handler is gone from PaneTile — role:'cut' is inert on the pane again");
  assert.match(
    cutHandler[0],
    /shouldRouteNativeCutToTerminal\(/,
    'the cut claim decision bypasses the unit-tested routing helper',
  );
  assert.match(
    cutHandler[0],
    /clipboardData\.setData\('text\/plain', term\.getSelection\(\)\)/,
    "the cut route must write the selection through the event's own clipboardData — the gesture originates in MAIN, so an execCommand('copy') issued from it has no user activation (measured live: it returns without writing)",
  );
  assert.match(
    cutHandler[0],
    /term\.clearSelection\(\)/,
    'the cut route must clear the selection after copying — copy-then-clear is the honest terminal reading',
  );
  assert.match(
    pane,
    /document\.addEventListener\('cut', onNativeCutCapture, true\)/,
    "the cut listener must be CAPTURE-phase (the role's event targets the focused element; the pane must see it first)",
  );

  // SELECT ALL: the pane claims the broadcast behind an identity check.
  const selectAllHandler = pane.match(/const onMenuSelectAll = \(\) => \{[\s\S]*?\n    \};/);
  assert.ok(selectAllHandler, 'the WARDEN-1356 select-all claim handler is gone from PaneTile — Edit ▸ Select All is inert on the pane again');
  assert.match(
    selectAllHandler[0],
    /document\.activeElement !== term\.textarea/,
    'the pane must claim the select-all broadcast ONLY when its own textarea holds real DOM focus — this identity test is what protects Settings',
  );
  assert.match(
    selectAllHandler[0],
    /term\.selectAll\(\)/,
    'the claim must select the pane buffer (term.selectAll) — the capability the bare role never reached',
  );
  assert.match(
    pane,
    /window\.addEventListener\(TERMINAL_SELECT_ALL_EVENT, onMenuSelectAll\)/,
    'PaneTile no longer listens for the menu select-all broadcast',
  );

  // SELECT ALL: App routes the pushed event by real DOM focus.
  const routeEffect = app.match(/useEffect\(\(\) => onSelectAll\(\(\) => \{[\s\S]*?\n  \}\), \[\]\);/);
  assert.ok(routeEffect, 'App.tsx no longer subscribes to the menu select-all push');
  assert.match(
    routeEffect[0],
    /routeMenuSelectAll\(document\.activeElement\)/,
    'the route decision must read REAL DOM focus, not the focusedChat state (a Settings field can hold the keyboard while focusedChat still names a pane)',
  );
  assert.match(
    routeEffect[0],
    /TERMINAL_SELECT_ALL_EVENT/,
    'the terminal route must broadcast to the panes',
  );
  assert.match(
    routeEffect[0],
    /execCommand\('selectAll'\)/,
    "the editable route must keep native Select All working in fields — the Settings constraint the role used to satisfy",
  );
});

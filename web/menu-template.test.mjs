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
const { buildMenuTemplate, flattenMenuItems } = require('../electron/menu-template.cjs');

const PLATFORMS = ['darwin', 'win32', 'linux'];

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
  test(`[${platform}] every leaf item leads somewhere real (a role or a handler)`, () => {
    const { template } = buildWithSpies(platform);
    const items = flattenMenuItems(template);
    assert.ok(items.length > 0, 'the template has items');
    for (const item of items) {
      const leadsSomewhere = typeof item.role === 'string' || typeof item.click === 'function';
      assert.ok(
        leadsSomewhere,
        `menu item ${JSON.stringify(item.label ?? item)} has neither a role nor a click handler — it is a dead item`,
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
    // File > New Window: Warden holds no single-instance lock, so a second
    // instance's killStalePort() kills the FIRST instance's backend.
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
    // Edit — why Copy/Paste/Select All work inside Settings text fields.
    for (const r of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
      assert.ok(roles.has(r), `edit role '${r}' missing`);
    }
    // View — why Reload reloads the app view.
    for (const r of ['reload', 'forceReload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']) {
      assert.ok(roles.has(r), `view role '${r}' missing`);
    }
    // Window.
    for (const r of ['minimize', 'zoom']) {
      assert.ok(roles.has(r), `window role '${r}' missing`);
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

// The Yatfa Warden application-menu TEMPLATE (WARDEN-1280).
//
// WHY THIS FILE IS SPLIT OUT OF main.cjs (the window-state.cjs precedent):
// main.cjs `require('electron')`, so it can only run under Electron itself and
// cannot be exercised by `node --test`. This module is deliberately
// ELECTRON-FREE — it builds and returns a plain template ARRAY of the shape
// `Menu.buildFromTemplate` accepts, with every non-role action injected as a
// handler by main. That makes the menu's SHAPE (which items exist, what they
// lead to, what the platform variants are) unit-testable in
// web/menu-template.test.mjs, which is the only place the "every item leads
// somewhere real" contract can actually be asserted.
//
// WHAT REPLACING THE STOCK TEMPLATE BUYS (and what it must not lose):
// Warden never called `Menu.setApplicationMenu`, so it shipped Electron's stock
// template — which advertises "About Electron" (the wrong app), Help links to
// electronjs.org (someone else's website), and File > New Window. That last one
// is not merely dead: Warden holds no single-instance lock, so a second instance
// boots and runs killStalePort() against the FIRST instance's backend on the same
// port. Removing the item removes the menu's invitation to that path.
//
// The stock template is ALSO why Cmd+C/Cmd+V and Cmd+R work today, so every
// platform-standard role it provided is reproduced here verbatim: a hand-written
// menu that forgets editMenu/viewMenu/windowMenu is a regression, not a cleanup.
// Roles dispatch to the focused webContents exactly as the stock items did.
//
// NO INVENTED DESTINATIONS: package.json carries no repository/homepage/bugs/
// author/license fields, so there is nothing behind a "Documentation" or "Report
// Issue" item — and an item that opens nothing real is exactly what this slice
// removes. Every item below is either a platform-standard role or points at a
// capability that already exists (Settings, the stall journal, the data folder).

/**
 * Build the application-menu template.
 *
 * @param {object} opts
 * @param {string} [opts.platform]  process.platform ('darwin' | 'win32' | 'linux' | …)
 * @param {string} [opts.appName]   the product name shown in the macOS app menu
 * @param {object} [opts.handlers]  injected actions (main wires the live Electron APIs):
 *   - ensureMainWindowVisible() restore the main window IF it is hidden (no-op
 *     when it is visible) — run before every window-targeting action; see the
 *     REACHABILITY block below
 *   - openSettings()       push 'menu:open-settings' to the renderer
 *   - showAbout()          native About dialog (Windows/Linux; macOS uses role:'about')
 *   - showStallDiagnostics() native dialog summarizing ~/.yatfa-warden/stalls.jsonl
 *   - openDataFolder()     shell.openPath on ~/.yatfa-warden/
 *   - toggleMaximize()     maximize/restore the live window (Windows/Linux Window menu;
 *                          macOS uses role:'zoom', which AppKit handles natively)
 * @returns {Array<object>} a Menu.buildFromTemplate-compatible template
 */

// --- REACHABILITY (WARDEN-1333) ---------------------------------------------
// With close-to-tray ON the window is hidden but ALIVE (the close intercept
// hide()s it; window-all-closed never fires, so the app keeps running), and on
// macOS the application menu bar stays present and fully clickable in exactly
// that state. A menu action that targets the main window is therefore only real
// if it first makes the window visible: Settings pushed into a hidden window
// opens where nobody can see it, and a dialog parented to a hidden window sits
// open awaiting a click with zero visible windows.
//
// The rule lives HERE, not in main.cjs, for the same reason the template does
// (the window-state.cjs split): this module is electron-free, so the rule is
// unit-testable, and the wrap below applies it to the handlers as the template
// is BUILT — so the next window-targeting handler added to this menu inherits
// the rule instead of re-forgetting it. menu-template.test.mjs asserts the
// ordering (ensure BEFORE act) and pins main.cjs's wiring of
// `ensureMainWindowVisible` by source assertion, since main.cjs itself cannot
// be required under `node --test`.
//
// Pure decision: does this window need restoring before an action that targets
// it can reach its user? main.cjs wires the live BrowserWindow to this (its
// ensureMainWindowVisible) and restores through showMainWindow() — which is
// show()+focus(), exactly the restore the tray has used since close-to-tray
// shipped (WARDEN-330).
function windowNeedsRestore(w) {
  return Boolean(w && !w.isDestroyed() && !w.isVisible());
}

// Actions exempt from the reachability wrap, each with its recorded reason.
// Deliberately an explicit list: exempting an action must be a stated decision
// (its item is added here WITH a reason), never an accident of forgetting to
// wrap it — and the test suite asserts the observable behaviour of the one
// exemption below.
const REACHABILITY_EXEMPT = new Map([
  // Its destination is the OS file manager (shell.openPath on ~/.yatfa-warden/),
  // not the app window: the user sees the folder open whether or not the app
  // window is visible, so restoring the window would be a spurious raise the
  // item never promised.
  ['openDataFolder', 'opens the OS file manager, not the app window'],
]);

function buildMenuTemplate({ platform = process.platform, appName = 'Yatfa Warden', handlers = {} } = {}) {
  const isMac = platform === 'darwin';
  const noop = () => {};

  // The reachability wrap (WARDEN-1333): every injected action runs main's
  // ensureMainWindowVisible() BEFORE doing its work, so a click made while the
  // window is hidden to the tray restores the window instead of vanishing into
  // it. The callback itself is a no-op while the window is visible (see the
  // isVisible gate in main.cjs), so nothing raises or steals focus on the
  // ordinary visible-window path. With the callback absent (legacy callers,
  // tests that inject only their own handlers) the wrap degrades to an
  // unwired click rather than throwing — the wiring itself is pinned by the
  // source assertions in web/menu-template.test.mjs.
  const ensureVisible =
    typeof handlers.ensureMainWindowVisible === 'function' ? handlers.ensureMainWindowVisible : null;
  const reach = (name, action) => {
    const fn = action || noop;
    if (!ensureVisible || REACHABILITY_EXEMPT.has(name)) return fn;
    return (...args) => { ensureVisible(); return fn(...args); };
  };

  const openSettings = reach('openSettings', handlers.openSettings);
  const showAbout = reach('showAbout', handlers.showAbout);
  const showStallDiagnostics = reach('showStallDiagnostics', handlers.showStallDiagnostics);
  const openDataFolder = reach('openDataFolder', handlers.openDataFolder);
  const toggleMaximize = reach('toggleMaximize', handlers.toggleMaximize);

  // The Settings item. On macOS the platform convention puts Preferences in the
  // APP menu (Cmd+,); on Windows/Linux it belongs in File (Ctrl+,). Same handler,
  // same accelerator label — only the parent menu differs.
  const settingsItem = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => openSettings(),
  };

  // Diagnostics items — shared by the macOS Help menu and the Windows/Linux Help
  // menu, so the two platform variants can never drift apart.
  const diagnosticsItems = [
    { label: 'Stall Diagnostics…', click: () => showStallDiagnostics() },
    { label: 'Open Data Folder', click: () => openDataFolder() },
  ];

  const template = [];

  // --- macOS app menu -------------------------------------------------------
  // The conventions a mac user expects from the leftmost menu: About (which the
  // 'about' role renders from app.setAboutPanelOptions — the real app name and
  // the real version, not "About Electron"), Services, hide/hideOthers/unhide,
  // and Quit. Preferences sits here per the platform convention.
  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settingsItem,
        { type: 'separator' },
        { role: 'services', submenu: [] },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  // --- File -----------------------------------------------------------------
  // NO "New Window" (see the header note — a second instance kills the first
  // instance's backend). On Windows/Linux this is where Settings lives and where
  // Quit lives; on macOS both are in the app menu, leaving Close Window as the
  // one honest File action.
  template.push({
    label: 'File',
    submenu: isMac
      ? [{ role: 'close' }]
      : [settingsItem, { type: 'separator' }, { role: 'quit' }],
  });

  // --- Edit / View / Window -------------------------------------------------
  // Reproduced from the stock template. These are why Copy/Paste/Select All work
  // inside Settings text fields and why Reload reloads the app view; dropping any
  // of them would be a regression introduced by this ticket, not a cleanup.
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }]
        : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  // --- Window ---------------------------------------------------------------
  // ZOOM IS PLATFORM-SPLIT ON PURPOSE (WARDEN-1313). In Electron 43 the `zoom`
  // role is `{ label: 'Zoom' }` — it carries NO appMethod/windowMethod/
  // webContentsMethod, so `MenuItem.execute()` returns false and, with no `click`
  // of its own, the item does literally nothing. On macOS that is CORRECT: the
  // role has no `nonNativeMacOSRole`, so Electron deliberately declines to
  // execute it and hands the item to AppKit's native window-zoom — the item is
  // real there and must not change. Off macOS nothing picks it up, so the item
  // renders enabled and inert — an inherited dead item, exactly what this
  // roadmap forbids. Windows/Linux therefore get a real maximize/restore item
  // wired through the injected `toggleMaximize` handler (main.cjs owns the live
  // BrowserWindow; this module stays electron-free).
  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      ...(isMac
        ? [{ role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ label: 'Maximize / Restore', click: () => toggleMaximize() }, { role: 'close' }]),
    ],
  });

  // --- Help -----------------------------------------------------------------
  // The diagnostics home. On Windows/Linux it also carries About (there is no app
  // menu to hold it, and `role: 'about'` renders no panel off macOS — so main
  // injects a native dialog with the SAME facts: name, version, description).
  // Zero external URLs by construction: there is no destination to point at.
  template.push({
    label: 'Help',
    role: 'help',
    submenu: isMac
      ? [...diagnosticsItems]
      : [...diagnosticsItems, { type: 'separator' }, { label: `About ${appName}`, click: () => showAbout() }],
  });

  return template;
}

/**
 * Flatten a template into its leaf items (separators excluded), depth-first.
 * Used by the tests to assert the whole-menu invariants — "no dead items", "no
 * external URLs" — without re-walking the nesting in every assertion.
 */
function flattenMenuItems(template) {
  const out = [];
  const walk = (items) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'separator') continue;
      if (Array.isArray(item.submenu) && item.submenu.length > 0) {
        walk(item.submenu);
        continue;
      }
      out.push(item);
    }
  };
  walk(template);
  return out;
}

module.exports = { buildMenuTemplate, flattenMenuItems, windowNeedsRestore, REACHABILITY_EXEMPT };

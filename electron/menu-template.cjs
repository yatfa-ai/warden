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
 *   - openSettings()       push 'menu:open-settings' to the renderer
 *   - showAbout()          native About dialog (Windows/Linux; macOS uses role:'about')
 *   - showStallDiagnostics() native dialog summarizing ~/.yatfa-warden/stalls.jsonl
 *   - openDataFolder()     shell.openPath on ~/.yatfa-warden/
 * @returns {Array<object>} a Menu.buildFromTemplate-compatible template
 */
function buildMenuTemplate({ platform = process.platform, appName = 'Yatfa Warden', handlers = {} } = {}) {
  const isMac = platform === 'darwin';
  const noop = () => {};
  const openSettings = handlers.openSettings || noop;
  const showAbout = handlers.showAbout || noop;
  const showStallDiagnostics = handlers.showStallDiagnostics || noop;
  const openDataFolder = handlers.openDataFolder || noop;

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

  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac
        ? [{ type: 'separator' }, { role: 'front' }]
        : [{ role: 'close' }]),
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

module.exports = { buildMenuTemplate, flattenMenuItems };

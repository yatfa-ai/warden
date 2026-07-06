// Headless smoke test: load the dashboard, collect console/page errors, open a chat tile.
const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');
// Find Edge/Chromium dynamically (Windows/macOS/Linux)
function findBrowser() {
  const candidates = process.platform === 'win32'
    ? [() => execSync('where msedge', { encoding: 'utf8' }).trim().split('\n')[0]]
    : [() => '/usr/bin/chromium', () => '/usr/bin/chromium-browser', () => '/usr/bin/google-chrome'];
  for (const fn of candidates) { try { const p = fn(); if (p && require('fs').existsSync(p)) return p; } catch {} }
  // Fallback: common Windows path
  const win = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  try { if (require('fs').existsSync(win)) return win; } catch {}
  throw new Error('No browser found for smoke test. Install Edge or Chromium.');
}
const EDGE = findBrowser();

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));

    await page.goto('http://localhost:7421', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.setViewport({ width: 1280, height: 800 });
    // wait for the chat list to populate (a known container name appears)
    await page.waitForFunction(() => /yatfa-|cham-|1xdata-/.test(document.body.innerText), { timeout: 20000 });

    const rootKids = await page.evaluate(() => document.querySelector('#root')?.children.length || 0);
    const chatBtns = await page.evaluate(() =>
      [...document.querySelectorAll('[data-chat-key]')].map((e) => e.getAttribute('data-chat-key')).slice(0, 4));
    console.log('root children:', rootKids);
    console.log('chat rows:', JSON.stringify(chatBtns));

    // open the first chat tile
    await page.evaluate(() => { document.querySelector('[data-chat-key]')?.click(); });
    await new Promise((r) => setTimeout(r, 3500)); // allow monitor snapshot to arrive

    const xterm = await page.evaluate(() => {
      const rows = document.querySelector('.xterm-rows');
      const x = document.querySelector('.xterm');
      return { present: !!rows, textLen: (rows?.textContent || '').length, h: x?.clientHeight || 0, w: x?.clientWidth || 0 };
    });
    console.log('xterm:', JSON.stringify(xterm));

    // open up to 4 chats to exercise the 2x2 prebuilt layout
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-chat-key]')];
      for (let i = 1; i < Math.min(4, rows.length); i++) rows[i].click();
    });
    await new Promise((r) => setTimeout(r, 3000));
    const grid = await page.evaluate(() => {
      const g = document.querySelector('[data-pane-grid]');
      const xterms = document.querySelectorAll('.xterm').length;
      let cols = 0;
      if (g) { const t = getComputedStyle(g).gridTemplateColumns.split(' '); cols = t.length; }
      return { xterms, cols };
    });
    console.log('grid:', JSON.stringify(grid));

    // observer tabs: a session is auto-created on boot; panel + "+" should render
    const obs = await page.evaluate(() => ({
      input: !!document.querySelector('input[placeholder="ask the observer…"]'),
      newBtn: [...document.querySelectorAll('button')].some((b) => b.title === 'new observer session'),
    }));
    console.log('observer:', JSON.stringify(obs));

    console.log('\nERRORS:', errors.length ? '\n' + errors.slice(0, 20).join('\n') : 'none');
    await browser.close();
    const ok = errors.length === 0 && rootKids > 0 && chatBtns.length > 0 && xterm.present && xterm.h > 450 && grid.xterms === 4 && grid.cols === 2 && obs.input && obs.newBtn;
    console.log(ok ? '\n✓ SMOKE PASS' : '\n✗ SMOKE FAIL');
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('SMOKE FAILED:', e.message);
    try { await browser.close(); } catch {}
    process.exit(2);
  }
})();

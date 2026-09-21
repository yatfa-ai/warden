// WARDEN-1403 round 2 — "Ink · Saved" — sidebar rebuilt around the four jobs.
//
// Non-app render (state matrix: every view at 208px and 320px on one page, which
// no production page shows). Style is LOCKED to round 1's Alternative 1 "Ink":
// identity chips, two-line rows, metadata never on the name line. The visual
// language, density answers and row anatomy are carried over verbatim; what
// changes is the information model, per the human's request-changes instruction.
//
// Component authored from the real app: tokens from web/src/index.css (GitHub
// Dark :root), row anatomy / status-dot vocabulary / wrap-anywhere name
// behaviour / the @max-[13rem] narrow tier from
// web/src/components/sidebar/ChatRows.tsx, shell structure from ChatSidebar.tsx.
//
//   node build-r2.mjs  →  ink-saved/index.html
import { writeFileSync, mkdirSync } from 'node:fs';

/* ================================ mock data ================================ */
/* Live counts are the UNSAVED shells open as panes on each host — they are NOT
 * listed in the sidebar; the host row's count is the only place they appear. */
const HOSTS = [
  { label: 'this machine', local: true, live: 24, saved: 5, status: 'online' },
  { label: 'build-farm-01', live: 31, saved: 6, status: 'online' },
  { label: 'gpu-node-02', live: 17, saved: 4, status: 'online' },
  { label: 'eu-west-runner', live: 6, saved: 2, status: 'online' },
  { label: 'staging-pi', live: 0, saved: 1, status: 'offline' },
];

/* build-farm-01's PERSISTENT sessions — the only reconnect targets. */
const WORKING = [
  { name: 'sidebar density', dir: '~/warden', time: '12s', justSaved: true },
  { name: 'release train 0.1.75', dir: '~/warden', time: '3m' },
  { name: 'reviewer yatfa', dir: '~/warden', time: '6m', agent: true },
  { name: 'telemetry batched sends', dir: '~/warden-telemetry', time: '18m' },
  { name: 'perf run nightly', dir: '~/warden', time: '41m', note: 'compare against the 0.1.72 baseline before merging' },
];
const STOPPED = [
  { name: 'docs pass — api reference and the migration guide', dir: '~/warden', time: '1d' },
  { name: 'sql tuner', dir: '~/warden-telemetry', time: '2d' },
  { name: 'font audit', dir: '~/warden/web', time: '3d' },
  { name: 'index rebuild', dir: '~/warden', time: '5d' },
];

/* Just-closed TEMPORARY sessions — reachable only from the header icon. A temp
 * that stops is gone for good and appears nowhere, so this list is short-lived
 * accident insurance, never a browsable history. */
const CLOSED_TEMPS = [
  { name: 'chat-4nh15o', dir: '~/warden', time: '40s' },
  { name: 'chat-6hu58k', dir: '~/warden-telemetry', time: '4m' },
  { name: 'shell · tmp', dir: '/tmp', time: '11m' },
  { name: 'chat-mo71sw', dir: '~/warden/web', time: '26m' },
];

const COLLECTIONS = [{ name: 'release train', n: 7 }, { name: 'infra work', n: 4 }];
const COLL_ROWS = [
  { name: 'release train 0.1.75', dir: '~/warden', time: '3m', host: 'build-farm-01', state: 'working' },
  { name: 'reviewer yatfa', dir: '~/warden', time: '6m', host: 'build-farm-01', state: 'working', agent: true },
  { name: 'worker yatfa', dir: '~/warden', time: '9m', host: 'this machine', state: 'working', agent: true },
  { name: 'changelog draft', dir: '~/warden', time: '2h', host: 'gpu-node-02', state: 'working' },
  { name: 'docs pass — api reference and the migration guide', dir: '~/warden', time: '1d', host: 'build-farm-01', state: 'stopped' },
  { name: 'release notes proof', dir: '~/warden', time: '2d', host: 'eu-west-runner', state: 'stopped' },
  { name: 'font audit', dir: '~/warden/web', time: '3d', host: 'build-farm-01', state: 'stopped' },
];

/* the search tab searches every host's saved sessions, so the list is long
 * enough that filtering is a real task. */
const ALL_SAVED = [
  ...WORKING.map(r => ({ ...r, host: 'build-farm-01', state: 'working' })),
  ...STOPPED.map(r => ({ ...r, host: 'build-farm-01', state: 'stopped' })),
  { name: 'worker yatfa', dir: '~/warden', time: '9m', host: 'this machine', state: 'working', agent: true },
  { name: 'planner yatfa', dir: '~/warden', time: '2m', host: 'this machine', state: 'working', agent: true },
  { name: 'dev server', dir: '~/warden', time: '1h', host: 'this machine', state: 'working' },
  { name: 'electron packaging', dir: '~/warden/electron', time: '4d', host: 'this machine', state: 'stopped' },
  { name: 'density spike', dir: '~/warden/web', time: '6d', host: 'this machine', state: 'stopped' },
  { name: 'model eval sweep', dir: '~/labs', time: '22m', host: 'gpu-node-02', state: 'working' },
  { name: 'changelog draft', dir: '~/warden', time: '2h', host: 'gpu-node-02', state: 'working' },
  { name: 'dataset rebuild', dir: '~/labs/data', time: '3d', host: 'gpu-node-02', state: 'stopped' },
  { name: 'tokenizer bench', dir: '~/labs', time: '8d', host: 'gpu-node-02', state: 'stopped' },
  { name: 'eu mirror sync', dir: '~/ops', time: '35m', host: 'eu-west-runner', state: 'working' },
  { name: 'release notes proof', dir: '~/warden', time: '2d', host: 'eu-west-runner', state: 'stopped' },
  { name: 'pi smoke test', dir: '~/warden', time: '9d', host: 'staging-pi', state: 'stopped' },
];

const SC = {
  branch: 'feat/sidebar-saved-sessions', diff: '+214 −96', ahead: 3, stash: 1,
  staged: [{ s: 'M', p: 'web/src/components/ChatSidebar.tsx' }, { s: 'A', p: 'web/src/components/sidebar/SavedSessionRows.tsx' }],
  changes: [{ s: 'M', p: 'web/src/components/sidebar/ChatRows.tsx' }, { s: 'D', p: 'web/src/pages/OpenChat.tsx' }, { s: '??', p: 'design/drafts' }],
  commits: [
    { h: '6302ec7', s: 'bump: 0.1.73 -> 0.1.74', t: '2h' },
    { h: 'd1a3844', s: '[#WARDEN-1399] fix(companion): bound the bootstrap-retry storm', t: '5h' },
    { h: '2165ab1', s: '[#WARDEN-1397] refactor(web): ObsUi save bag', t: '1d' },
  ],
};

/* =============================== helpers =============================== */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const hueOf = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const ICON = (d, cls = '', size = 11) => `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

/* lucide paths (the app uses lucide); emoji would render as tofu on hosts with
 * no emoji font, so every glyph here is an inline svg. */
const I = {
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  note: '<path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10l6-6V5a2 2 0 0 0-2-2Z"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-8.4-5.8"/><path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 8.4 5.8"/><path d="M21 3v6h-6"/><path d="M3 21v-6h6"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

/* ================================== css ================================== */
/* Text contrast policy (unchanged from round 1, which scored 0 violations):
 * every text node is #e6edf3 / #8b949e / #58c46f / #3fb950 / #79b8ff / #d29922 /
 * #f85149 / #56d4dd — all ≥4.5:1 on both #010409 and the #21262d hover accent.
 * Hierarchy comes from size, weight and spacing, never from dimmer inks, and
 * no opacity is applied to any text node. */
const CSS = `
:root{--bg:#0d1117;--sidebar:#010409;--card:#161b22;--fg:#e6edf3;--muted:#8b949e;
--border:#30363d;--border2:rgba(48,54,61,.55);--accent:#21262d;--link:#79b8ff;
--danger:#f85149;--warn:#d29922;--ok:#3fb950;--seclabel:#58c46f;--cyan:#56d4dd;--note:#c9950c;}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--fg);font:13px/1.45 'Geist Variable',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
.page{max-width:1000px;margin:0 auto;padding:18px 20px 44px}
.topbar{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:4px}
.topbar h1{font-size:14px;font-weight:600}
.topbar .sub{font-size:11px;color:var(--muted)}
.lede{font-size:11.5px;color:var(--muted);max-width:74ch;margin-top:6px;overflow-wrap:anywhere}
.tabs{display:flex;gap:4px;flex-wrap:wrap;margin:12px 0 14px;border-bottom:1px solid var(--border);padding-bottom:10px}
.tabs button{font:inherit;font-size:11.5px;color:var(--muted);background:none;border:1px solid transparent;border-radius:6px;padding:4px 10px;cursor:pointer}
.tabs button:hover{color:var(--fg);background:var(--accent)}
.tabs button.on{color:var(--fg);background:var(--accent);border-color:var(--border)}
section.tab{display:none}section.tab.on{display:block}
.colhead,.stage{display:grid;grid-template-columns:208px 320px;gap:26px;justify-content:center}
.colhead{margin:2px 0 6px}
.colhead span{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.pairrow{margin-bottom:24px}
.pairlabel{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 6px 2px;text-align:center}
.tabnote{font-size:11px;color:var(--muted);max-width:74ch;margin:0 auto 12px;text-align:center;overflow-wrap:anywhere}
.panel{position:relative;width:100%;height:648px;background:var(--sidebar);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;overflow:hidden;container-type:inline-size;min-width:0}
.panel.tall{height:auto;max-height:648px}
.sb{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.sb::-webkit-scrollbar{width:8px}.sb::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}

/* ---- header ---- */
/* The header carries a title, a search field and three icon buttons. At 208px
 * they cannot share a line without the search field collapsing to nothing, so
 * the row WRAPS and search takes the full second line — the field keeps its
 * full width instead of being squeezed out of existence. */
.shead{display:flex;align-items:center;gap:5px;padding:7px 8px;border-bottom:1px solid var(--border2);flex:none;flex-wrap:wrap}
.shead .lab{font-size:11.5px;color:var(--fg);flex:none;max-width:44%;overflow-wrap:anywhere}
.shead input{flex:1 1 112px;min-width:112px;height:22px;background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--fg);font:inherit;font-size:10.5px;padding:0 6px}
.shead .hgrp{display:flex;align-items:center;gap:3px;margin-left:auto;flex:none}
.shead input::placeholder{color:var(--muted)}
.shead input:focus{outline:none;border-color:var(--link)}
.icobtn{position:relative;display:inline-flex;align-items:center;gap:3px;font:inherit;font-size:10.5px;color:var(--muted);background:none;border:none;border-radius:4px;padding:2px 4px;cursor:pointer;flex:none}
.icobtn:hover{color:var(--fg);background:var(--accent)}
.icobtn.on{color:var(--link)}
.icobtn.red:hover{color:var(--danger)}
.icobtn .n{font-size:9.5px;color:var(--muted)}
.icobtn:hover .n{color:var(--fg)}

/* ---- spawn (job A) — plain shell: host + directory + optional name ---- */
/* Wraps rather than crushing: at 208px the directory takes its own line at full
 * width instead of being squeezed to two characters. */
.spawn{display:flex;align-items:center;gap:5px;padding:6px 8px;border-bottom:1px solid var(--border2);flex:none;flex-wrap:wrap}
.spawn .sel,.spawn .cwd{height:24px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:10.5px;padding:0 6px;display:flex;align-items:center;gap:4px;white-space:nowrap}
.spawn .sel{flex:none;min-width:0;overflow:hidden}
.spawn .cwd{flex:1;min-width:84px;color:var(--muted);overflow:hidden}
.spawn .go{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;padding:0 7px;border-radius:6px;border:1px solid var(--border);background:var(--accent);color:var(--fg);font:inherit;font-size:10.5px;cursor:pointer}
.spawn .go:hover{border-color:var(--seclabel);color:var(--fg)}
.spawn-x{display:block;padding:7px 8px;border-bottom:1px solid var(--border2);flex:none}
.spawn-x .fld{display:flex;align-items:center;gap:6px;margin-bottom:5px}
.spawn-x .k{font-size:10px;color:var(--muted);width:46px;flex:none}
.spawn-x .v{flex:1;min-width:0;min-height:24px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:10.5px;padding:4px 6px;display:flex;align-items:center;overflow-wrap:anywhere}
.spawn-x .v.ph{color:var(--muted)}
.spawn-x .go{width:100%;justify-content:center;height:26px;margin-top:2px}
.spawn-x .hint{font-size:10px;color:var(--muted);margin-top:5px;overflow-wrap:anywhere}
/* at 208px the label column would leave the field a sliver, so labels sit above
 * their fields instead — the field keeps the full width. */
@container (max-width: 240px){
  .spawn-x .fld{display:block}
  .spawn-x .k{width:auto;display:block;margin-bottom:2px}
}

/* ---- sections ---- */
.sec{display:flex;align-items:baseline;gap:6px;padding:9px 10px 3px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;color:var(--muted)}
.sec.pri{color:var(--seclabel)}
.sec .n{margin-left:auto;font-weight:400;letter-spacing:0;text-transform:none;font-size:10px;color:var(--muted)}
.sec .add{margin-left:auto}
.hdiv{border-top:1px solid var(--border2);margin:11px 8px 2px}
.subnote{padding:1px 10px 5px;font-size:10px;color:var(--muted);overflow-wrap:anywhere}

/* ---- host rows (job B — primary navigation) ---- */
.hrow{display:flex;align-items:center;gap:7px;margin:1px 4px;padding:6px 6px;border-radius:7px;font-size:11.5px;color:var(--fg);cursor:pointer;min-width:0}
.hrow:hover{background:var(--accent)}
.hrow .nm{flex:1;min-width:0;overflow-wrap:anywhere}
.hrow .live{font-size:10px;color:var(--seclabel);flex:none}
.hrow .savedn{font-size:10px;color:var(--muted);flex:none}
.hrow .offword{font-size:10px;color:var(--muted);flex:none}
.hrow .arr{color:var(--muted);flex:none;font-size:11px}
.hrow.off{color:var(--muted)}
.crow{display:flex;align-items:center;gap:7px;margin:1px 4px;padding:5px 6px;border-radius:7px;font-size:11.5px;color:var(--muted);cursor:pointer;min-width:0}
.crow:hover{background:var(--accent);color:var(--fg)}
.crow .nm{flex:1;min-width:0;overflow-wrap:anywhere}
.crow .n{font-size:10px;color:var(--muted);flex:none}

/* ---- status dots (kept from the app's vocabulary) ---- */
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
.dot.solid{background:var(--ok)}
.dot.ring{background:transparent;border:2px solid var(--muted);width:7px;height:7px}
.dot.sq{background:var(--danger);border-radius:2px;width:7px;height:7px}

/* ---- Ink row anatomy — identity chip + two lines (LOCKED, carried over) ---- */
.ik-row{display:block;padding:5px 8px 4px;border-radius:7px;cursor:pointer;margin:0 3px}
.ik-row:hover,.ik-row.foc{background:var(--accent)}
.ik-l1{display:flex;align-items:flex-start;gap:7px}
.ik-chip{width:3px;align-self:stretch;min-height:15px;border-radius:2px;flex:none}
.ik-l1 .dot{margin-top:4px}
.ik-name{flex:1;min-width:0;overflow-wrap:anywhere;font-size:12px;color:var(--fg)}
.ik-row.stop .ik-name{color:var(--muted)}
.ik-l2{display:flex;align-items:center;gap:6px;margin:2px 0 0 10px;font-size:10px;color:var(--muted);min-height:16px;flex-wrap:wrap}
.ik-meta{display:flex;align-items:center;gap:5px;min-width:0;overflow-wrap:anywhere}
.ik-dir{color:var(--muted)}
.ik-acts{display:flex;align-items:center;gap:1px;margin-left:auto;flex:none}
.ik-acts .icobtn{font-size:10px;padding:1px 3px}
.ik-acts .hov{display:none}
.ik-row:hover .ik-acts .hov,.ik-row:focus-within .ik-acts .hov{display:inline-flex}
.ik-row .respawn{border:1px solid var(--border);border-radius:5px;padding:1px 5px;color:var(--muted)}
.ik-row .respawn:hover{color:var(--fg);border-color:var(--seclabel)}
.note-sub{display:block;margin:2px 0 0 10px;font-size:10px;font-style:italic;color:var(--muted);overflow-wrap:anywhere}
.mk{flex:none;display:inline-flex;margin-top:2px}
.mk.note{color:var(--note)}
.mk.agent{font-size:9.5px;color:var(--cyan);font-style:normal;margin-top:1px}
.saved-pill{flex:none;font-size:9.5px;color:var(--ok);border:1px solid rgba(63,185,80,.45);border-radius:5px;padding:0 4px;margin-top:1px}
.hosttag{color:var(--muted);flex:none}
/* narrow degradation: the directory yields, the name and the actions never do.
 * The app's own narrow tier is @max-[13rem] (208px) — matched here. */
@container (max-width: 240px){ .ik-dir,.ik-sep{display:none} .hrow .savedn{display:none}
  /* at 208px the header cannot fit title + search + controls on one line, so
   * search takes its own full-width line under the title rather than being
   * squeezed to nothing — the field stays usable instead of vanishing. */
  .shead .hgrp{order:2} .shead input{order:3;flex-basis:100%} }

/* ---- recently-closed flyout (the ONLY route back to a closed temp) ---- */
.fly{position:absolute;top:38px;left:6px;right:6px;z-index:9;background:var(--card);border:1px solid var(--border);border-radius:9px;box-shadow:0 10px 26px rgba(1,4,9,.75);display:none;overflow:hidden}
.fly.open{display:block}
.fly .fhead{display:flex;align-items:center;gap:6px;padding:7px 9px;border-bottom:1px solid var(--border2);font-size:10.5px;color:var(--fg)}
.fly .fhead .x{margin-left:auto}
.fly .fbody{padding:3px 0 5px}
.fly .fnote{padding:5px 10px 7px;font-size:10px;color:var(--muted);border-top:1px solid var(--border2);overflow-wrap:anywhere}
.fly .ik-row:hover{background:var(--accent)}

/* ---- source control (job D — an add-on at the bottom) ---- */
.sc{margin:6px;border:1px solid var(--border2);border-radius:8px;background:rgba(22,27,34,.5)}
.schead{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;background:none;border:none;color:var(--fg);font:inherit;font-size:11px;cursor:pointer;text-align:left;min-width:0}
.schead .bn{min-width:0;overflow-wrap:anywhere}
.chev{color:var(--muted);font-size:9px;width:9px;flex:none}
.scbits{display:flex;gap:6px;margin-left:auto;font-size:10px;color:var(--muted);flex-wrap:wrap;overflow-wrap:anywhere}
.scbits .add{color:var(--ok)}
.scbody{padding:2px 8px 8px;border-top:1px solid var(--border2)}
.fgroup{padding:6px 0 1px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.file,.commit{display:flex;gap:6px;padding:2px 0 2px 8px;font-size:11px;min-width:0}
.file .st{flex:none;font-size:10px}
.file .st.M{color:var(--warn)}.file .st.A{color:var(--ok)}.file .st.D{color:var(--danger)}.file .st.Q{color:var(--muted)}
.file .p,.commit .s{min-width:0;overflow-wrap:anywhere}
.commit .h{color:var(--muted);flex:none}
.commit .t{margin-left:auto;color:var(--muted);flex:none;font-size:10px}

/* ---- empty / loading / no-match / error ---- */
.empty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:34px 16px;color:var(--muted);text-align:center}
.empty .t{font-size:12px;color:var(--fg)}
.empty .d{font-size:11px;color:var(--muted);overflow-wrap:anywhere}
.empty .cta{margin-top:4px;font-size:10.5px;color:var(--fg);background:var(--accent);border:1px solid var(--border);border-radius:6px;padding:3px 9px;cursor:pointer}
.nomatch{margin:8px;padding:8px 10px;border:1px dashed var(--border);border-radius:8px;font-size:11px;color:var(--muted);overflow-wrap:anywhere}
.nomatch a{color:var(--fg);cursor:pointer;text-decoration:underline}
.err{margin:8px;padding:8px 10px;border:1px solid rgba(248,81,73,.4);background:rgba(248,81,73,.1);border-radius:8px;font-size:11px;color:#ff8f88;overflow-wrap:anywhere}
.err a{color:#ff8f88;cursor:pointer;text-decoration:underline}
.skel-row{display:flex;gap:8px;align-items:center;margin:0 5px;padding:6px 6px}
.skel{height:10px;border-radius:4px;background:linear-gradient(90deg,#161b22 25%,#1f2630 50%,#161b22 75%);background-size:200% 100%;animation:shim 1.4s linear infinite}
.skel.dotp{width:8px;height:8px;border-radius:50%;flex:none}.skel.grow{flex:1}.skel.w12{width:24px}
@keyframes shim{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* ---- rename inline input ---- */
input.rename{flex:1;min-width:0;height:20px;background:var(--bg);border:1px solid var(--link);border-radius:5px;color:var(--fg);font:inherit;font-size:11.5px;padding:0 5px;outline:none}

/* ---- search result count ---- */
.flt-cnt{padding:5px 10px 6px;border-bottom:1px solid var(--border2);flex:none;font-size:10px;color:var(--muted);overflow-wrap:anywhere}
mark{background:rgba(63,185,80,.32);color:var(--fg);border-radius:2px;padding:0 1px}
.matrixlab{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:13px 4px 3px;overflow-wrap:anywhere}
.force-hover .ik-row{background:var(--accent)}
.force-hover .ik-acts .hov{display:inline-flex}
`;

/* ============================== row builders ============================== */
function chip(name) { return `<span class="ik-chip" style="background:hsl(${hueOf(name)} 62% 58%)"></span>`; }

/* A saved session row. `state` is 'working' (green dot — a live tmux session to
 * reconnect to) or 'stopped' (hollow dot — nothing is running). */
function savedRow(r, o = {}) {
  const stopped = r.state === 'stopped';
  const meta = stopped
    ? `<span>stopped ${r.time} ago</span>`
    : `<span>${r.time}</span>`;
  const dir = `<span class="ik-sep">·</span><span class="ik-dir">${esc(r.dir)}</span>`;
  const hostTag = o.showHost && r.host ? `<span class="ik-sep">·</span><span class="hosttag">${esc(r.host)}</span>` : '';
  const acts = `<span class="ik-acts">`
    + (stopped ? `<button class="icobtn respawn" title="respawn — starts a fresh process under this name in ${esc(r.dir)}; the stopped one cannot be resurrected">${ICON(I.rotate, '', 10)}respawn</button>` : '')
    + (r.agent ? '' : `<button class="icobtn hov" title="rename" aria-label="rename">${ICON(I.pencil, '', 10)}</button>`)
    + `<button class="icobtn hov" title="add a note" aria-label="add a note">${ICON(I.note, '', 10)}</button>`
    + `<button class="icobtn red" title="delete this saved session" aria-label="delete this saved session">${ICON(I.trash, '', 10)}</button>`
    + `</span>`;
  return `<div class="ik-row${stopped ? ' stop' : ''}${o.focused ? ' foc' : ''}"${o.focused ? ' aria-current="true"' : ''} title="${esc(r.name)}">
  <div class="ik-l1">${chip(r.name)}<span class="dot ${stopped ? 'ring' : 'solid'}" title="${stopped ? 'stopped — nothing running' : 'working — live tmux session'}"></span><span class="ik-name">${esc(r.name)}</span>${r.agent ? '<span class="mk agent">agent</span>' : ''}${r.note ? ICON(I.note, 'mk note', 10) : ''}${r.justSaved ? '<span class="saved-pill">saved</span>' : ''}</div>
  <div class="ik-l2"><span class="ik-meta">${meta}${dir}${hostTag}</span>${acts}</div>
  ${r.note ? `<div class="note-sub">${esc(r.note)}</div>` : ''}
</div>`;
}

/* A just-closed TEMPORARY session, inside the flyout. Its only two moves are
 * reopen (back to a pane, still temporary) and promote (make it persistent). */
function tempRow(r) {
  return `<div class="ik-row" title="${esc(r.name)}">
  <div class="ik-l1">${chip(r.name)}<span class="dot ring" title="closed"></span><span class="ik-name">${esc(r.name)}</span></div>
  <div class="ik-l2"><span class="ik-meta"><span>closed ${r.time} ago</span><span class="ik-sep">·</span><span class="ik-dir">${esc(r.dir)}</span></span>
  <span class="ik-acts"><button class="icobtn" title="reopen as a pane — still temporary">reopen</button><button class="icobtn" title="save — keep this session; it moves into the host's saved list">${ICON(I.bookmark, '', 10)}save</button></span></div>
</div>`;
}

function hostRow(h) {
  return `<div class="hrow${h.status === 'offline' ? ' off' : ''}" title="${esc(h.label)}">
  <span class="dot ${h.status === 'offline' ? 'sq' : 'solid'}" title="${h.status}"></span>
  <span class="nm">${esc(h.label)}</span>
  ${h.status === 'offline' ? '<span class="offword">offline</span>' : `<span class="live">${h.live} live</span>`}
  <span class="savedn">${h.saved} saved</span><span class="arr">›</span></div>`;
}

/* ============================ section builders ============================ */
function header(o = {}) {
  const closedCount = CLOSED_TEMPS.length;
  return `<div class="shead">
  ${o.back ? `<button class="icobtn" title="back" aria-label="back">‹</button>` : ''}
  ${o.title ? `<span class="lab">${esc(o.title)}</span>` : ''}
  <input class="${o.live ? 'flt-in ' : ''}shead-in" placeholder="${o.ph || 'search saved sessions…'}" aria-label="search saved sessions"${o.q ? ` value="${o.q}"` : ''} spellcheck="false">
  <span class="hgrp">
  <button class="icobtn" data-fly title="recently closed — ${closedCount} temporary sessions you closed; they disappear on their own" aria-label="recently closed">${ICON(I.history, '', 12)}<span class="n">${closedCount}</span></button>
  <button class="icobtn${o.sort ? ' on' : ''}" title="sort &amp; filter" aria-label="sort and filter">${ICON(I.sliders, '', 12)}</button>
  <button class="icobtn" title="refresh" aria-label="refresh">${ICON(I.refresh, '', 12)}</button>
  </span>
</div>`;
}

function flyout(open = false) {
  return `<div class="fly${open ? ' open' : ''}" data-flypanel>
  <div class="fhead">${ICON(I.history, '', 12)}<span>recently closed</span><button class="icobtn x" data-flyclose title="close" aria-label="close">${ICON(I.x, '', 11)}</button></div>
  <div class="fbody">${CLOSED_TEMPS.map(tempRow).join('')}</div>
  <div class="fnote">Temporary sessions. Reopening keeps them temporary; saving moves one into this host's saved list. A temporary session that stops is gone for good.</div>
</div>`;
}

function spawnCollapsed() {
  /* Honest: it shows exactly what it opens — a shell on a host in a directory.
   * No prompt field, because the expanded form has none either. */
  return `<div class="spawn">
  <span class="sel">${ICON(I.server, '', 10)}build-farm-01 ▾</span>
  <span class="cwd" title="~/warden">~/warden</span>
  <button class="go" data-spawn title="start a shell here">${ICON(I.plus, '', 11)}shell</button>
</div>`;
}

function spawnExpanded() {
  return `<div class="spawn-x">
  <div class="fld"><span class="k">host</span><span class="v">${ICON(I.server, '', 10)}&nbsp;build-farm-01 ▾</span></div>
  <div class="fld"><span class="k">directory</span><span class="v">~/warden</span></div>
  <div class="fld"><span class="k">name</span><span class="v ph">optional — name it to save it</span></div>
  <button class="go" title="start a shell">${ICON(I.plus, '', 11)}Start shell</button>
  <div class="hint">Unnamed shells are temporary: they run as a pane and are not listed here. Give it a name and it is saved — it appears under the host and you can come back to it.</div>
</div>`;
}

function sourceControl(expanded) {
  return `<div class="sc">
  <button class="schead" data-g><span class="chev">${expanded ? '▾' : '▸'}</span>${ICON(I.branch, '', 11)}<span class="bn">${SC.branch}</span><span class="scbits"><span class="add">${SC.diff}</span><span title="ahead of origin">↑${SC.ahead}</span><span title="stashed changes">≡${SC.stash}</span></span></button>
  <div class="scbody"${expanded ? '' : ' style="display:none"'}>
    <div class="fgroup">staged changes</div>${SC.staged.map(f => `<div class="file"><span class="st ${f.s}">${f.s}</span><span class="p">${esc(f.p)}</span></div>`).join('')}
    <div class="fgroup">changes</div>${SC.changes.map(f => `<div class="file"><span class="st ${f.s[0] === '?' ? 'Q' : f.s}">${f.s}</span><span class="p">${esc(f.p)}</span></div>`).join('')}
    <div class="fgroup">recent commits</div>${SC.commits.map(c => `<div class="commit"><span class="h">${c.h}</span><span class="s">${esc(c.s)}</span><span class="t">${c.t}</span></div>`).join('')}
  </div>
</div>`;
}

/* --------------------------------- views --------------------------------- */
function rootView() {
  const totalLive = HOSTS.reduce((a, h) => a + h.live, 0);
  return `${header({ ph: 'search saved sessions…' })}${flyout()}${spawnCollapsed()}
<div class="sb">
  <div class="sec pri">hosts<span class="n">${totalLive} live</span></div>
  ${HOSTS.filter(h => h.status !== 'offline').map(hostRow).join('')}
  ${HOSTS.filter(h => h.status === 'offline').map(hostRow).join('')}
  <div class="hdiv"></div>
  <div class="sec">collections<button class="icobtn add" title="new collection" aria-label="new collection">${ICON(I.plus, '', 11)}</button></div>
  ${COLLECTIONS.map(c => `<div class="crow" title="${esc(c.name)}">${ICON(I.grid, '', 11)}<span class="nm">${esc(c.name)}</span><span class="n">${c.n}</span><span class="arr">›</span></div>`).join('')}
  <div class="hdiv"></div>
  ${sourceControl(false)}
  <div style="height:10px"></div>
</div>`;
}

function hostView() {
  const h = HOSTS[1];
  return `${header({ back: true, title: 'build-farm-01', ph: 'search this host…' })}${flyout()}${spawnCollapsed()}
<div class="sb">
  <div class="sec pri">working<span class="n">${WORKING.length}</span></div>
  <div class="subnote">Click to reconnect to the running session.</div>
  ${WORKING.map((r, i) => savedRow({ ...r, state: 'working' }, { focused: i === 1 })).join('')}
  <div class="hdiv"></div>
  <div class="sec">stopped<span class="n">${STOPPED.length}</span></div>
  <div class="subnote">Respawn starts a <strong style="font-weight:600;color:var(--fg)">fresh</strong> process under the same name in the same directory — the stopped one cannot be resurrected.</div>
  ${STOPPED.map(r => savedRow({ ...r, state: 'stopped' })).join('')}
  <div class="hdiv"></div>
  <div class="subnote">${h.live} shells are running on this host as panes. They are not saved, so they are not listed — name one to keep it.</div>
  <div style="height:10px"></div>
</div>`;
}

function collectionView() {
  const work = COLL_ROWS.filter(r => r.state === 'working');
  const stop = COLL_ROWS.filter(r => r.state === 'stopped');
  return `${header({ back: true, title: 'release train', ph: 'search this collection…' })}${flyout()}
<div class="sb">
  <div class="subnote" style="padding:8px 10px 2px">Saved sessions from several hosts, grouped by hand for the 0.1.75 release.</div>
  <div class="sec pri">working<span class="n">${work.length}</span></div>
  ${work.map(r => savedRow(r, { showHost: true })).join('')}
  <div class="hdiv"></div>
  <div class="sec">stopped<span class="n">${stop.length}</span></div>
  ${stop.map(r => savedRow(r, { showHost: true })).join('')}
  <div style="height:10px"></div>
</div>`;
}

function rowsView() {
  const R = (label, html) => `<div class="matrixlab">${label}</div>${html}`;
  return `<div class="sb" style="padding-bottom:14px">
  ${R('focused — working', savedRow({ name: 'release train 0.1.75', dir: '~/warden', time: '3m', state: 'working' }, { focused: true }))}
  ${R('working — live tmux session (click reconnects)', savedRow({ name: 'telemetry batched sends', dir: '~/warden-telemetry', time: '18m', state: 'working' }))}
  ${R('just saved — a temporary session was named', savedRow({ name: 'sidebar density', dir: '~/warden', time: '12s', state: 'working', justSaved: true }))}
  ${R('stopped — respawn is a fresh process, same name and directory', savedRow({ name: 'sql tuner', dir: '~/warden-telemetry', time: '2d', state: 'stopped' }))}
  ${R('stopped — a name long enough to wrap, never clipped', savedRow({ name: 'docs pass — api reference and the migration guide', dir: '~/warden', time: '1d', state: 'stopped' }))}
  ${R('carrying a note', savedRow({ name: 'perf run nightly', dir: '~/warden', time: '41m', state: 'working', note: 'compare against the 0.1.72 baseline before merging' }))}
  ${R('agent-owned — the name belongs to the agent, so it is not renameable', savedRow({ name: 'reviewer yatfa', dir: '~/warden', time: '6m', state: 'working', agent: true }))}
  ${R('user-owned — renameable, shown here with its host', savedRow({ name: 'model eval sweep', dir: '~/labs', time: '22m', host: 'gpu-node-02', state: 'working' }, { showHost: true }))}
  ${R('being renamed', `<div class="ik-row foc"><div class="ik-l1">${chip('perf run nightly')}<span class="dot solid"></span><input class="rename" value="perf run nightly" aria-label="rename session"></div><div class="ik-l2"><span class="ik-meta"><span>41m</span><span class="ik-sep">·</span><span class="ik-dir">~/warden</span></span></div></div>`)}
  ${R('closed temporary — only ever seen inside the flyout', tempRow(CLOSED_TEMPS[0]))}
  <div style="height:8px"></div>
</div>`;
}

function hoverView() {
  return `<div class="sb" style="padding-bottom:14px">
  <div class="matrixlab">at rest — working: delete is the only always-visible action</div>
  ${savedRow({ name: 'release train 0.1.75', dir: '~/warden', time: '3m', state: 'working' })}
  <div class="matrixlab">hover — working: rename and note join it</div>
  <div class="force-hover">${savedRow({ name: 'release train 0.1.75', dir: '~/warden', time: '3m', state: 'working' })}</div>
  <div class="matrixlab">at rest — stopped: respawn is always visible, it is the point of the row</div>
  ${savedRow({ name: 'sql tuner', dir: '~/warden-telemetry', time: '2d', state: 'stopped' })}
  <div class="matrixlab">hover — stopped: respawn · rename · note · delete</div>
  <div class="force-hover">${savedRow({ name: 'sql tuner', dir: '~/warden-telemetry', time: '2d', state: 'stopped' })}</div>
  <div class="matrixlab">hover — agent-owned: no rename (the agent owns the name)</div>
  <div class="force-hover">${savedRow({ name: 'reviewer yatfa', dir: '~/warden', time: '6m', state: 'working', agent: true })}</div>
  <div class="matrixlab">hover — closed temporary: reopen, or save to keep it</div>
  <div class="force-hover">${tempRow(CLOSED_TEMPS[1])}</div>
  <div class="matrixlab">live hover target — point at this row</div>
  ${savedRow({ name: 'font audit', dir: '~/warden/web', time: '3d', state: 'stopped' })}
  <div style="height:8px"></div>
</div>`;
}

function statesView() {
  const skel = [1, 2, 3, 4, 5].map(() => `<div class="skel-row"><span class="skel dotp"></span><span class="skel grow"></span><span class="skel w12"></span></div>`).join('');
  return `<div class="sb">
  <div class="matrixlab">loading — a host's saved sessions</div>${skel}
  <div class="hdiv"></div>
  <div class="matrixlab">empty — this host has nothing saved yet</div>
  <div class="empty">${ICON(I.bookmark, '', 18)}<span class="t">Nothing saved on gpu-node-02</span><span class="d">17 shells are running here as panes. Name one and it will be listed here.</span><button class="cta">${ICON(I.plus, '', 10)} Start a shell</button></div>
  <div class="hdiv"></div>
  <div class="matrixlab">no match for the search — "carbon"</div>
  <div class="nomatch">No saved session matches "carbon" — <a>clear the search</a>. Running shells are not searched: they are not saved.</div>
  <div class="hdiv"></div>
  <div class="matrixlab">host unreachable — unknown, not empty</div>
  <div class="err">Could not reach staging-pi — connection timed out. Its saved sessions are unknown, not absent. <a>retry</a></div>
  <div style="height:10px"></div>
</div>`;
}

function scView(expanded) {
  return `<div class="sb" style="padding:6px 0">${sourceControl(expanded)}</div>`;
}

function filterView() {
  /* The header already carries the search field, so the live one IS that field —
   * no second box. */
  return `${header({ back: true, title: 'all hosts', ph: 'search saved sessions…', sort: true, live: true, q: 're' })}${flyout()}
<div class="fc flt-cnt"></div>
<div class="sb flt-list">${ALL_SAVED.map(r => savedRow(r, { showHost: true })).join('')}</div>
<div class="nomatch flt-none" style="display:none">No saved session matches the search — <a class="flt-clear">clear the search</a>. Running shells are not searched: they are not saved.</div>`;
}

/* ============================== page assembly ============================== */
const TABS = [
  ['root', 'root', 'Hosts are the primary navigation and carry their live count; collections sit beneath them, muted; git status is an add-on at the bottom. The spawn control shows exactly what it opens — a host, a directory and a shell — and nothing it cannot deliver.'],
  ['host', 'host — working &amp; stopped', 'Only this host\'s saved sessions are listed. Working rows reconnect on click; stopped rows carry an explicit respawn, because recreating a process is a different act from resuming one. The 31 unsaved shells running here are panes, and the footer line is where they are accounted for.'],
  ['closed', 'recently closed', 'The header icon is the only route back to a temporary session you closed. From here it can be reopened as a temporary pane, or saved — which moves it into the host\'s list.'],
  ['collection', 'collection', 'A hand-made group of saved sessions from several hosts, using the same two-state split as the host view and adding the host as the one extra piece of metadata.'],
  ['rows', 'row conditions', 'Every condition a row can be in. Names wrap and are never clipped or ellipsised, so editing one reflows the row instead of hiding the edit.'],
  ['hover', 'hover actions', 'Delete is visible at rest on every saved row; rename and note are revealed on hover. Respawn is visible at rest on stopped rows. The rows below marked "hover" are pinned into that state so both can be compared side by side.'],
  ['states', 'loading · empty · no match', 'The empty state answers the question it will actually be asked — "where are my shells?" — instead of only saying there is nothing here.'],
  ['sc', 'source control', 'Unchanged in behaviour, moved to the bottom of root and collapsed by default: it is an add-on, not a core section.'],
  ['filter', 'search', 'Searching across every host\'s saved sessions. Match counts and highlighting are live in this bundle — type in the box.'],
];

function panelPair(html, tall = false) {
  return `<div class="stage"><div class="panel${tall ? ' tall' : ''}">${html}</div><div class="panel${tall ? ' tall' : ''}">${html}</div></div>`;
}

const SECTIONS = {
  root: `${panelPair(rootView())}
    <div class="pairrow" style="margin-top:24px"><div class="pairlabel">spawn expanded — host · directory · optional name</div>${panelPair(`${header({ ph: 'search saved sessions…' })}${spawnExpanded()}<div class="sb"><div class="sec pri">hosts<span class="n">78 live</span></div>${HOSTS.filter(h => h.status !== 'offline').map(hostRow).join('')}</div>`, true)}</div>`,
  host: panelPair(hostView()),
  closed: panelPair(`${header({ back: true, title: 'build-farm-01' })}${flyout(true)}${spawnCollapsed()}<div class="sb"><div class="sec pri">working<span class="n">${WORKING.length}</span></div>${WORKING.slice(0, 3).map(r => savedRow({ ...r, state: 'working' })).join('')}<div class="hdiv"></div><div class="sec">stopped<span class="n">${STOPPED.length}</span></div>${STOPPED.slice(0, 2).map(r => savedRow({ ...r, state: 'stopped' })).join('')}</div>`),
  collection: panelPair(collectionView()),
  rows: panelPair(rowsView(), true),
  hover: panelPair(hoverView(), true),
  states: panelPair(statesView(), true),
  sc: `<div class="pairrow"><div class="pairlabel">collapsed — the default</div>${panelPair(scView(false), true)}</div>
       <div class="pairrow"><div class="pairlabel">expanded — working tree, diffstat, recent commits</div>${panelPair(scView(true), true)}</div>`,
  filter: panelPair(filterView()),
};

const COLHEAD = `<div class="colhead"><span>narrow · 208 px</span><span>comfortable · 320 px</span></div>`;

function page() {
  const tabsHtml = TABS.map(([k, lab], i) => `<button data-t="${k}" class="${i === 0 ? 'on' : ''}">${lab}</button>`).join('');
  const sectionsHtml = TABS.map(([k, , note], i) =>
    `<section class="tab ${i === 0 ? 'on' : ''}" data-tab="${k}"><p class="tabnote">${note}</p>${COLHEAD}${SECTIONS[k]}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WARDEN-1403 · Ink · Saved</title><style>${CSS}</style></head><body><div class="page">
<div class="topbar"><h1>Warden sidebar — Ink · Saved</h1><span class="sub">state matrix · every view at 208 px and 320 px</span></div>
<p class="lede">The sidebar does four things, in this order: start a shell, reach a host, come back to a session you saved, and see git status. Everything a session needs to be findable is a name you gave it — so the list is short by construction, and the scanning problem the first round solved with colour and density is solved here by there being only a handful of rows to scan. Ink's row anatomy is unchanged: an identity chip, the name alone on the first line, and metadata on a second line that never competes with it.</p>
<nav class="tabs">${tabsHtml}</nav>
${sectionsHtml}
</div><script>
(function(){
  /* tabs */
  document.querySelectorAll('.tabs button').forEach(function(b){b.addEventListener('click',function(){
    document.querySelectorAll('.tabs button').forEach(function(x){x.classList.remove('on')});b.classList.add('on');
    document.querySelectorAll('section.tab').forEach(function(s){s.classList.toggle('on',s.dataset.tab===b.dataset.t)});
  });});
  /* source-control collapse */
  document.addEventListener('click',function(e){
    var h=e.target.closest('[data-g]');if(!h)return;
    var body=h.nextElementSibling;if(!body)return;
    var open=body.style.display==='none';
    body.style.display=open?'':'none';
    var ch=h.querySelector('.chev');if(ch)ch.textContent=open?'▾':'▸';
  });
  /* recently-closed flyout */
  document.addEventListener('click',function(e){
    var t=e.target.closest('[data-fly]');
    if(t){
      var panel=t.closest('.panel')||document;
      var fly=panel.querySelector('[data-flypanel]');
      if(fly)fly.classList.toggle('open');
      e.stopPropagation();
      return;
    }
    var c=e.target.closest('[data-flyclose]');
    if(c){var f=c.closest('[data-flypanel]');if(f)f.classList.remove('open');}
  });
  /* live search — the header's own field, scoped to its panel */
  document.querySelectorAll('.flt-in').forEach(function(inp){
    var panel=inp.closest('.panel');if(!panel)return;
    var list=panel.querySelector('.flt-list'),cnt=panel.querySelector('.flt-cnt'),none=panel.querySelector('.flt-none');
    if(!list||!cnt||!none)return;
    function run(){
      var q=inp.value.trim().toLowerCase(),n=0,total=0;
      [].slice.call(list.children).forEach(function(r){
        if(!r.classList.contains('ik-row'))return;
        total++;
        var el=r.querySelector('.ik-name');
        if(el){if(el._orig===undefined)el._orig=el.innerHTML;el.innerHTML=el._orig;}
        var nm=(el?el.textContent:r.textContent).toLowerCase();
        var hit=!q||nm.indexOf(q)>=0;
        r.style.display=hit?'':'none';
        if(hit)n++;
        if(hit&&q&&el){
          var walk=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),nodes=[];
          while(walk.nextNode())nodes.push(walk.currentNode);
          var re=new RegExp(q.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&'),'ig');
          nodes.forEach(function(tn){
            var v=tn.nodeValue;if(!re.test(v))return;re.lastIndex=0;
            var frag=document.createDocumentFragment(),last=0,m;
            while((m=re.exec(v))!==null){
              if(m.index>last)frag.appendChild(document.createTextNode(v.slice(last,m.index)));
              var mk=document.createElement('mark');mk.textContent=m[0];frag.appendChild(mk);
              last=m.index+m[0].length;
              if(m[0].length===0)re.lastIndex++;
            }
            if(last<v.length)frag.appendChild(document.createTextNode(v.slice(last)));
            tn.parentNode.replaceChild(frag,tn);
          });
        }
      });
      cnt.textContent=q?n+' of '+total+' saved sessions match "'+inp.value.trim()+'"':total+' saved sessions — type to search';
      none.style.display=n?'none':'';
    }
    inp.addEventListener('input',run);run();
    var cl=none.querySelector('.flt-clear');
    if(cl)cl.addEventListener('click',function(){inp.value='';run();inp.focus();});
  });
})();
</script></body></html>`;
}

mkdirSync(new URL('./ink-saved/', import.meta.url), { recursive: true });
writeFileSync(new URL('./ink-saved/index.html', import.meta.url), page());
console.log('built: ink-saved/index.html');

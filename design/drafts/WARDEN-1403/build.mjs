// WARDEN-1403 — sidebar redesign state-matrix exhibits (non-app render: the brief
// demands every state on one page at two widths, which no production page shows).
// Component authored from the real app: tokens from web/src/index.css (GitHub Dark),
// row anatomy from web/src/components/sidebar/ChatRows.tsx, section vocabulary and
// capability inventory from ChatSidebar.tsx. Emits three self-contained bundles.
//   node build.mjs   →  ink/index.html  ledger/index.html  buckets/index.html
import { writeFileSync, mkdirSync } from 'node:fs';

/* ---------------------------------- mock data ---------------------------------- */
const HOSTS = [
  { name: 'this machine', label: 'this machine', local: true, active: 4, status: 'online' },
  { name: 'build-farm-01', label: 'build-farm-01', active: 12, status: 'online' },
  { name: 'gpu-node-02', label: 'gpu-node-02', active: 3, status: 'online' },
  { name: 'staging-pi', label: 'staging-pi', active: 0, status: 'offline' },
];
const OPEN_PANES = [
  { name: 'planner yatfa', type: 'yatfa', role: 'planner', host: 'this machine', state: 'open', time: '2m', focused: true },
  { name: 'worker yatfa', type: 'yatfa', role: 'worker', host: 'this machine', state: 'active', time: '4m' },
  { name: 'reviewer yatfa', type: 'yatfa', role: 'reviewer', host: 'build-farm-01', state: 'open', time: '12m' },
  { name: 'refactor chat resolution', type: 'claude', host: 'this machine', state: 'open', time: '31m', note: 'runs the dedup suite first' },
  { name: 'fix sidebar wrap', type: 'claude', host: 'gpu-node-02', state: 'active', time: '1h', watch: 'ok' },
  { name: 'migrate telemetry pipeline', type: 'resume', host: 'build-farm-01', state: 'open', time: '3h' },
  { name: 'chat-4nh15o', type: 'claude', host: 'build-farm-01', state: 'open', time: '5h', watch: 'stuck' },
  { name: 'shell · warden', type: 'shell', host: 'this machine', state: 'open', time: '2d', pinned: true },
];
const CLOSED = [
  { name: 'cache warm', host: 'gpu-node-02', time: '26m' },
  { name: 'chat-b6m4sq', host: 'build-farm-01', time: '1h' },
  { name: 'experiment: retry budget', host: 'this machine', time: '3h' },
  { name: 'shell · tmp', host: 'this machine', time: '5h' },
  { name: 'chat-j4r8yp', host: 'build-farm-01', time: '1d' },
];
const TAILS = ['4nh15o','6hu58k','mo71sw','9dpz2q','k3v8tx','p2wn7c','r8j4mh','t5qy1b','x7cv3n','z2k9wd','b6m4sq','f9h2tk','j4r8yp','l7s3vm','n1w6zd','q5t2kc','u8y6rb','w3e9xn','a2x8vk','c7m3p9','d4n8qt','e9b2wj','g5r7xl','h1t6ym','i6k4zs','o8u3vf'];
const CHAT_MARKS = { 'chat-4nh15o': { watch: 'stuck' }, 'chat-6hu58k': { watch: 'custom' }, 'chat-mo71sw': { note: 'owner: yatfa-worker' } };
const NAMED_LIVE = [
  { name: 'perf run nightly', note: 'compare against 0.1.72 baseline' },
  { name: 'docs pass' },
  { name: 'bug triage', pinned: true },
];
const NAMED_IDLE = ['sql tuner','log scanner','cache warm','index rebuild','api mock','font audit'].map(n => ({ name: n }));
const live = TAILS.slice(0, 18).map(t => ({ name: `chat-${t}`, time: `${1 + (t.charCodeAt(0) % 9)}h`, ...(CHAT_MARKS[`chat-${t}`] || {}) }));
const liveNamed = NAMED_LIVE.map(n => ({ time: '22m', ...n }));
const idleChats = [...TAILS.slice(18).map(t => ({ name: `chat-${t}`, time: `${1 + (t.charCodeAt(0) % 4)}d` })), ...NAMED_IDLE.map(n => ({ time: '6d', ...n }))];
const HOST_CHATS = { live: [...live, ...liveNamed], idle: idleChats };
const SESSIONS = [
  { sum: 'Refactor the chat resolution path into a shared utility', meta: '4h · warden · 1.2M', tag: 'wip' },
  { sum: 'Fix flaky tmux attach on slow links', meta: '9h · warden · 840k' },
  { sum: 'Add per-host failure cooldown to companion channel', meta: '1d · companion · 2.1M', tag: 'infra' },
  { sum: 'Migrate telemetry pipeline to batched sends', meta: '2d · warden · 660k' },
  { sum: 'Sidebar wrap-anywhere regression + tests', meta: '3d · web · 310k' },
  { sum: 'Instrument pane input latency', meta: '5d · web · 95k' },
];
const SC = {
  branch: 'feat/sidebar-density', diff: '+128 −44', ahead: 2, stash: 1,
  staged: [{ s: 'M', p: 'src/agentFilter.ts' }, { s: 'A', p: 'src/density.ts' }],
  changes: [{ s: 'M', p: 'web/src/components/ChatSidebar.tsx' }, { s: 'M', p: 'web/src/components/sidebar/ChatRows.tsx' }, { s: '??', p: 'design/drafts' }],
  commits: [
    { h: '6302ec7', s: 'bump: 0.1.73 -> 0.1.74', t: '2h' },
    { h: 'd1a3844', s: '[#WARDEN-1399] fix(companion): bound the bootstrap-retry storm', t: '5h' },
    { h: '2165ab1', s: '[#WARDEN-1397] refactor(web): ObsUi save bag', t: '1d' },
  ],
};
const COLLECTIONS = [{ name: 'release train', n: 9 }, { name: 'needs-you', n: 2 }];
const COLL_AGENTS = [
  { name: 'worker yatfa', type: 'yatfa', role: 'worker', host: 'this machine', state: 'active', time: '4m' },
  { name: 'reviewer yatfa', type: 'yatfa', role: 'reviewer', host: 'build-farm-01', state: 'open', time: '12m' },
  { name: 'chat-4nh15o', state: 'open', time: '5h', watch: 'stuck' },
  { name: 'chat-6hu58k', state: 'active', time: '18m', watch: 'custom' },
  { name: 'bug triage', state: 'open', time: '44m', pinned: true },
  { name: 'perf run nightly', state: 'active', time: '22m', note: 'compare against 0.1.72 baseline' },
  { name: 'docs pass', state: 'idle', time: '2h' },
  { name: 'sql tuner', state: 'idle', time: '6d' },
  { name: 'shell · warden', type: 'shell', host: 'this machine', state: 'idle', time: '2d' },
];
const TYPE_COLOR = { claude: 'var(--t-claude)', resume: 'var(--t-resume)', shell: 'var(--t-shell)', yatfa: 'var(--t-yatfa)', manual: 'var(--t-manual)' };
const hueOf = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
/* inline SVG icons (lucide paths, stroke currentColor) — the app uses lucide icons,
 * and emoji fallbacks render as tofu on hosts without an emoji font. */
const ICON = (d, cls = '', size = 11) => `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>',
  note: '<path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10l6-6V5a2 2 0 0 0-2-2Z"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
};

/* ------------------------------ shared chrome + base css ------------------------------ */
/* Text contrast policy: every text node is #e6edf3 or #8b949e (≥4.5:1 on the
 * sidebar blacks); hierarchy comes from size/weight/spacing, never from dimmer
 * inks — the machine-measured contrast scorecard is part of this deliverable. */
const BASE_CSS = `
:root{--bg:#0d1117;--sidebar:#010409;--card:#161b22;--fg:#e6edf3;--muted:#8b949e;
--border:#30363d;--border2:rgba(48,54,61,.55);--accent:#21262d;--primary:#2f81f7;--danger:#f85149;--warn:#d29922;--ok:#3fb950;--seclabel:#58c46f;--cyan:#56d4dd;
--t-claude:#4ade80;--t-resume:#22d3ee;--t-shell:#facc15;--t-yatfa:#60a5fa;--t-manual:#a78bfa;--watch:#4493f8;--pin:#d29922;--note:#c9950c;}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--fg);font:13px/1.45 'Geist Variable',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
.page{max-width:980px;margin:0 auto;padding:18px 20px 40px}
.topbar{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:10px}
.topbar h1{font-size:14px;font-weight:600}
.topbar .sub{font-size:11px;color:var(--muted)}
.tabs{display:flex;gap:4px;flex-wrap:wrap;margin:10px 0 14px;border-bottom:1px solid var(--border);padding-bottom:10px}
.tabs button{font:inherit;font-size:11.5px;color:var(--muted);background:none;border:1px solid transparent;border-radius:6px;padding:4px 10px;cursor:pointer}
.tabs button:hover{color:var(--fg);background:var(--accent)}
.tabs button.on{color:var(--fg);background:var(--accent);border-color:var(--border)}
.colhead{display:grid;grid-template-columns:208px 320px;gap:26px;justify-content:center;margin:2px 0 6px}
.colhead span{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.stage{display:grid;grid-template-columns:208px 320px;gap:26px;justify-content:center}
section.tab{display:none}section.tab.on{display:block}
.panel{width:100%;height:640px;background:var(--sidebar);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;overflow:hidden;container-type:inline-size;min-width:0}
.panel.tall{height:auto;max-height:640px}
.sb{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.sb::-webkit-scrollbar{width:8px}.sb::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.pairrow{margin-bottom:26px}
.pairlabel{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 6px 2px}
/* shared sidebar furniture (header, sections, inputs, dots) — density per direction */
.shead{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border2);flex:none}
.shead .lab{font-size:11px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42%;flex:none}
.shead input{flex:1;min-width:24px;height:22px;background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--fg);font:inherit;font-size:10.5px;padding:0 6px}
.shead input::placeholder{color:var(--muted)}
.shead .cnt{font-size:10.5px;background:var(--accent);border:1px solid var(--border2);color:var(--fg);border-radius:5px;padding:0 5px;flex:none}
.shead .ago{font-size:10px;color:var(--muted);flex:none}
.icobtn{font:inherit;font-size:11px;color:var(--muted);background:none;border:none;border-radius:4px;padding:1px 4px;cursor:pointer;flex:none}
.icobtn:hover{color:var(--fg);background:var(--accent)}
.icobtn.on{color:var(--primary)}
.icobtn.red:hover{color:var(--danger)}
.sec{padding:7px 10px 3px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;color:var(--muted)}
.sec.pri{color:var(--seclabel)}
.sec.cyan{color:var(--cyan)}
.secrow{display:flex;align-items:baseline;gap:6px;padding:7px 10px 3px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
.dot.solid{background:var(--ok)}.dot.ring{background:transparent;border:2px solid var(--muted);width:7px;height:7px}
.dot.sq{background:var(--danger);border-radius:2px}
.dot.pulse{background:var(--danger);animation:pul 1.2s ease-in-out infinite}
.dot.warn{background:var(--warn)}
@keyframes pul{0%,100%{opacity:1}50%{opacity:.35}}
.glyph{color:var(--ok);font-size:11px;line-height:1;flex:none}
.hdiv{border-top:1px solid var(--border2);margin:10px 6px 2px}
.spawn{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid var(--border2)}
.spawn .sel,.spawn .cwd{height:24px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:10.5px;padding:0 6px;display:flex;align-items:center;white-space:nowrap;overflow:hidden}
.spawn .sel{flex:none}.spawn .cwd{flex:1;min-width:0;color:var(--muted)}
.spawn .prompt{flex:2;min-width:30px;height:24px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:10.5px;padding:0 6px}
.spawn .prompt::placeholder{color:var(--muted)}
.spawn .go{flex:none;width:24px;height:24px;border-radius:6px;border:1px solid var(--border);background:var(--accent);color:var(--fg);cursor:pointer}
.sc{margin:4px 6px 2px;border:1px solid var(--border2);border-radius:8px;background:rgba(22,27,34,.5)}
.schead{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;background:none;border:none;color:var(--fg);font:inherit;font-size:11px;cursor:pointer;text-align:left}
.chev{color:var(--muted);font-size:9px;width:9px;flex:none}
.scbits{display:flex;gap:6px;margin-left:auto;font-size:10px;color:var(--muted);flex-wrap:wrap;overflow-wrap:anywhere}
.scbits .add{color:var(--t-claude)}.scbits .del{color:var(--danger)}
.scbody{padding:2px 8px 8px;border-top:1px solid var(--border2)}
.fgroup{padding:5px 0 1px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.file{display:flex;gap:6px;padding:2px 0 2px 8px;font-size:11px;color:var(--fg);overflow-wrap:anywhere;min-width:0}
.file .st{flex:none;font-size:10px}
.file .st.M{color:var(--warn)}.file .st.A{color:var(--t-claude)}.file .st.Q{color:var(--muted)}
.commit{display:flex;gap:6px;padding:2px 0 2px 8px;font-size:11px;min-width:0}
.commit .h{color:var(--muted);flex:none}.commit .s{min-width:0;overflow-wrap:anywhere}.commit .t{margin-left:auto;color:var(--muted);flex:none;font-size:10px}
.hrow,.crow{display:flex;align-items:center;gap:8px;margin:1px 4px;padding:5px 6px;border-radius:6px;font-size:11.5px;color:var(--muted);cursor:pointer}
.hrow:hover,.crow:hover{background:var(--accent);color:var(--fg)}
.hrow .nm,.crow .nm{flex:1;min-width:0;overflow-wrap:anywhere}
.hrow .tag{font-size:10px;color:var(--cyan)}
.hrow .n{font-size:10px;color:var(--muted)}
.hrow .arr{color:var(--muted)}
.offline-t{display:flex;align-items:center;gap:6px;margin:2px 6px;padding:5px 6px;border-radius:6px;font-size:11px;color:var(--muted);cursor:pointer}
.sesstag{display:flex;gap:4px;padding:2px 10px 4px;flex-wrap:wrap}
.sesstag .tg{font-size:9.5px;border:1px solid var(--border);border-radius:5px;color:var(--muted);padding:1px 5px;cursor:pointer}
.sesstag .tg.on{color:var(--fg);background:var(--accent)}
.sesstag .tg.add{color:var(--muted);border-style:dashed}
.selbar{flex:none;display:flex;align-items:center;gap:6px;border-top:1px solid var(--border);background:var(--card);padding:6px 8px;font-size:10.5px;color:var(--muted);flex-wrap:wrap}
.selbar b{color:var(--fg);font-weight:600}
.selbar button{font:inherit;font-size:10.5px;color:var(--fg);background:var(--accent);border:1px solid var(--border);border-radius:6px;padding:2px 7px;cursor:pointer}
.selbar button.red:hover{border-color:var(--danger);color:var(--danger)}
.empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:34px 16px;color:var(--muted);text-align:center}
.empty .ic{font-size:20px;opacity:.85}
.empty .t{font-size:12px;color:var(--fg)}
.empty .d{font-size:11px;color:var(--muted)}
.nomatch{margin:8px;padding:8px 10px;border:1px dashed var(--border);border-radius:8px;font-size:11px;color:var(--muted)}
.nomatch a{color:var(--fg);cursor:pointer;text-decoration:underline}
.err{margin:8px;padding:8px 10px;border:1px solid rgba(248,81,73,.35);background:rgba(248,81,73,.1);border-radius:8px;font-size:11px;color:#ff8f88}
.err a{color:#ff8f88;cursor:pointer;text-decoration:underline}
input.rename{flex:1;min-width:0;height:20px;background:var(--bg);border:1px solid var(--primary);border-radius:5px;color:var(--fg);font:inherit;font-size:11px;padding:0 5px;outline:none}
.note-sub{display:block;margin:2px 0 0 16px;font-size:10px;font-style:italic;color:var(--muted);overflow-wrap:anywhere}
.mini-note{font-size:10px;color:var(--muted);padding:6px 10px 2px}
.matrixlab{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:14px 2px 4px}
.mk-eye{color:var(--watch);flex:none;display:inline-flex}
.mk-pin{color:var(--pin);flex:none;display:inline-flex}
.mk-note{color:var(--note);flex:none;display:inline-flex}
.ica{color:var(--muted);flex:none;display:inline-flex;margin:0 1px}
.filterbox{padding:6px 8px;border-bottom:1px solid var(--border2);flex:none}
.filterbox input{width:100%;height:24px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);font:inherit;font-size:11px;padding:0 8px}
.filterbox input::placeholder{color:var(--muted)}
.filterbox input:focus{outline:none;border-color:var(--primary)}
.filterbox .fc{font-size:10px;color:var(--muted);margin-top:3px}
@container (max-width: 240px){ .shead .ago{display:none} }
.skel-row{display:flex;gap:8px;align-items:center;margin:0 4px;padding:5px 6px}
.skel{height:10px;border-radius:4px;background:linear-gradient(90deg,#161b22 25%,#1f2630 50%,#161b22 75%);background-size:200% 100%;animation:shim 1.4s linear infinite}
@keyframes shim{0%{background-position:200% 0}100%{background-position:-200% 0}}
.skel.dotp{width:8px;height:8px;border-radius:50%;flex:none}.skel.grow{flex:1}.skel.w12{width:22px}
mark{background:rgba(63,185,80,.3);color:var(--fg);border-radius:2px;padding:0 1px}
`;

/* ------------------------------ shared row helpers ------------------------------ */
function markers(r) {
  let m = '';
  if (r.watch === 'stuck') m += `<span class="dot pulse" title="watched — needs you: stuck (mechanical repetition)"></span>`;
  else if (r.watch === 'custom') m += `<span class="dot warn" title="watched — needs you: pattern match '0 errors' (pattern: done)"></span>`;
  else if (r.watch === 'ok') m += ICON(I.eye, 'mk-eye', 11);
  if (r.pinned) m += ICON(I.pin, 'mk-pin', 10);
  if (r.note) m += ICON(I.note, 'mk-note', 10);
  return m;
}
function stateDot(r) {
  if (r.state === 'open') return `<span class="dot solid" title="Open"></span>`;
  if (r.state === 'active') return `<span class="glyph" title="Active">◐</span>`;
  if (r.state === 'dead') return `<span class="dot sq" title="Dead"></span>`;
  return `<span class="dot ring" title="Idle"></span>`;
}
function acts(r, o = {}) {
  return `<span class="${o.actcls}">${ICON(I.eye, 'ica', 11)}${ICON(I.pin, 'ica', 11)}${ICON(I.note, 'ica', 11)}${r.type === 'yatfa' ? '' : '<span class="icobtn" title="rename">✎</span>'}<span class="icobtn red" title="${o.close || 'close pane'}">×</span></span>`;
}
function typeBadges(r) {
  return `<span class="ty" style="color:${TYPE_COLOR[r.type]}">${r.type}</span>${r.role ? `<span class="hs">${r.role}</span>` : ''}<span class="hs">${r.host}</span>`;
}

/* ---- direction A · "Ink" — identity chip + two-line rows ---- */
function inkRow(r, o = {}) {
  return `<div class="ik-row${r.focused ? ' foc' : ''}${r.state === 'idle' ? ' dim' : ''}" ${r.focused ? 'aria-current="true"' : ''}>
  <div class="ik-l1"><span class="ik-chip" style="background:hsl(${hueOf(r.name)} 62% 58%)"></span><span class="ik-name"${o.full ? ` title="${esc(r.name)}"` : ''}>${esc(r.name)}</span>${markers(r)}</div>
  <div class="ik-l2"><span class="ik-time">${r.time}</span>${o.host || ''}<span class="ik-badges">${typeBadges(r)}</span>${acts(r, { actcls: 'ik-acts' })}</div>
  ${r.note ? `<div class="note-sub">${esc(r.note)}</div>` : ''}
</div>`;
}
const ink = {
  nmSel: '.ik-name', rowCls: 'ik-row',
  css: `
.ik-row{display:block;padding:5px 8px 4px;border-radius:7px;cursor:pointer;margin:0 3px}
.ik-row:hover,.ik-row.foc{background:var(--accent)}
.dim .ik-name{color:var(--muted)}
.ik-l1{display:flex;align-items:flex-start;gap:7px}
.ik-chip{width:3px;align-self:stretch;min-height:14px;border-radius:2px;flex:none}
.ik-name{flex:1;min-width:0;overflow-wrap:anywhere;font-size:12px}
.ik-l1 .dot{margin-top:3px}.ik-l1 .glyph{margin-top:2px}
.mk-eye,.mk-pin,.mk-note{margin-top:2px}
.ik-l2{display:flex;align-items:center;gap:6px;margin:1px 0 0 10px;font-size:10px;color:var(--muted);min-height:15px}
.ik-time{flex:none}
.ik-host{color:var(--muted)}
.ik-badges{display:none;gap:6px;min-width:0;overflow:hidden;white-space:nowrap}
.ik-acts{display:none;gap:1px;margin-left:auto;flex:none}
.ik-acts .icobtn{font-size:10px;padding:0 2px}
.ik-row:hover .ik-badges{display:flex}
.ik-row:hover .ik-acts{display:flex}
.ik-row:hover .ik-time,.ik-row:hover .ik-host{display:none}
@container (max-width: 240px){ .ik-badges .hs{display:none} .ik-host{display:none} }
`,
  chatRow: (r, o) => inkRow(r, { ...o, host: r.host !== 'this machine' ? `<span class="ik-host">${r.host}</span>` : '' }),
  paneRow: (r) => inkRow(r, { full: true, host: r.host !== 'this machine' ? `<span class="ik-host">${r.host}</span>` : '' }),
  closedRow: (r) => `<div class="ik-row"><div class="ik-l1"><span class="dot ring"></span><span class="ik-name" style="color:var(--muted)">${esc(r.name)}</span></div><div class="ik-l2"><span class="ik-time">${r.time}</span><span class="ik-badges"><span class="hs">${r.host}</span></span><span class="ik-acts"><span class="icobtn" title="reopen">↩</span></span></div></div>`,
  hostRow: (h) => `<div class="hrow"><span class="dot ${h.active ? 'solid' : 'ring'}"></span><span class="nm" style="color:var(--fg)">${h.label}</span>${h.local ? '<span class="tag">local</span>' : `<span class="dot ${h.status === 'online' ? 'solid' : 'sq'}" title="${h.status}"></span>`}<span class="n">${h.active || ''}</span><span class="arr">›</span></div>`,
  sessionRow: (s) => `<div class="ik-row"><div class="ik-l1"><span class="ik-name" style="font-size:11.5px" title="resume — click to resume this session">${esc(s.sum)}</span></div><div class="ik-l2"><span class="ik-time">${s.meta}</span><span class="ik-acts"><span class="icobtn" title="resume">↩</span><span class="icobtn" title="add tag">＋</span></span></div>${s.tag ? `<div class="sesstag" style="padding:2px 0 0 10px"><span class="tg on">${s.tag}</span></div>` : ''}</div>`,
};

/* ---- direction B · "Ledger" — dense single-line, tail-priority names ---- */
function ledName(r) {
  const m = /^(chat-)([0-9a-z]+)$/.exec(r.name);
  if (m) return `<span class="led-pre"><span class="pre-t">chat-</span><span class="pre-m">…</span></span><span class="led-tail">${m[2]}</span>`;
  return `<span class="led-tail">${esc(r.name)}</span>`;
}
function ledGutter(r) {
  return `<span class="led-gut"><span class="g-time">${r.time}</span><span class="g-type" style="color:${TYPE_COLOR[r.type]}">${r.type === 'shell' ? 'sh' : r.type.slice(0, 4)}</span><span class="g-host">${r.host === 'this machine' ? 'local' : r.host.split('-')[0]}</span></span>`;
}
function ledRow(r, o = {}) {
  return `<div class="led-row${r.focused ? ' foc' : ''}${r.state === 'idle' ? ' dim' : ''}" ${r.focused ? 'aria-current="true"' : ''}>
  ${stateDot(r)}<span class="led-namewrap"${o.full ? ` title="${esc(r.name)}"` : ''}>${ledName(r)}</span>
  ${markers(r)}${ledGutter(r)}${acts(r, { actcls: 'led-acts' })}
</div>${r.note ? `<div class="note-sub">${esc(r.note)}</div>` : ''}`;
}
const ledger = {
  nmSel: '.led-tail', rowCls: 'led-row',
  css: `
.led-row{display:flex;align-items:center;gap:6px;margin:0 3px;padding:3px 6px;border-radius:6px;cursor:pointer;min-height:24px}
.led-row:hover,.led-row.foc{background:var(--accent)}
.led-row+.note-sub{margin-top:-2px}
.dim .led-namewrap{color:var(--muted)}
.led-namewrap{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;font-size:12px}
.led-pre{color:var(--muted)}
.led-pre .pre-m{display:none}
.led-gut{display:flex;gap:5px;flex:none;font-size:10px;color:var(--muted)}
.led-gut .g-host{color:var(--muted)}
.led-acts{display:none;gap:1px;flex:none;align-items:center}
.led-acts .icobtn{font-size:10px;padding:0 2px}
.led-row:hover .led-gut{display:none}
.led-row:hover .led-acts{display:flex}
/* the gutter steps down as the panel narrows: host → type → gone; time survives.
 * breakpoints in px: container-query rem resolves against the container's font size */
@container (max-width: 312px){ .led-gut .g-host{display:none} }
@container (max-width: 240px){ .led-gut .g-type{display:none} .led-pre .pre-t{display:none} .led-pre .pre-m{display:inline} }
@container (max-width: 200px){ .led-gut{display:none} }
`,
  chatRow: ledRow,
  paneRow: (r) => ledRow(r, { full: true }),
  closedRow: (r) => `<div class="led-row dim"><span class="dot ring"></span><span class="led-namewrap">${ledName({ name: r.name })}</span><span class="led-gut"><span class="g-time">${r.time}</span><span class="g-host">${r.host === 'this machine' ? 'local' : r.host.split('-')[0]}</span></span><span class="led-acts"><span class="icobtn" title="reopen">↩</span></span></div>`,
  hostRow: (h) => `<div class="hrow" style="padding:3px 6px;margin:0 3px"><span class="dot ${h.active ? 'solid' : 'ring'}"></span><span class="nm" style="color:var(--fg)">${h.label}</span>${h.local ? '<span class="tag">local</span>' : `<span class="dot ${h.status === 'online' ? 'solid' : 'sq'}" title="${h.status}"></span>`}<span class="n">${h.active || ''}</span><span class="arr">›</span></div>`,
  sessionRow: (s) => `<div class="led-row" style="min-height:0;padding:4px 6px"><span class="led-namewrap" style="font-size:11.5px" title="${esc(s.sum)} — click to resume">${ledName({ name: s.sum })}</span><span class="led-gut"><span class="g-time">${s.meta.split(' · ').pop()}</span><span class="icobtn" title="resume">↩</span></span></div>${s.tag ? `<div class="sesstag" style="padding:0 10px 4px 12px"><span class="tg on">${s.tag}</span></div>` : ''}`,
};

/* ---- direction C · "Buckets" — collapsible groups + persistent filter ---- */
function famName(name, tailOnly = false) {
  const m = /^(chat-)([0-9a-z]+)$/.exec(name);
  if (m) return `${tailOnly ? '' : '<span class="bk-pre">chat-</span>'}<span class="bk-tail">${m[2]}</span>`;
  return esc(name);
}
function bktRow(r, o = {}) {
  return `<div class="bk-row${r.focused ? ' foc' : ''}${r.state === 'idle' ? ' dim' : ''}" ${r.focused ? 'aria-current="true"' : ''}>
  <div class="bk-l1">${stateDot(r)}<span class="bk-name"${o.full ? ` title="${esc(r.name)}"` : ''}>${famName(r.name, o.tailOnly)}</span>${markers(r)}</div>
  <div class="bk-meta">${typeBadges(r)}<span>${r.time}</span></div>
  ${acts(r, { actcls: 'bk-acts' })}
</div>${r.note ? `<div class="note-sub">${esc(r.note)}</div>` : ''}`;
}
function groupHead(label, count, open = true, pri = false) {
  return `<div class="bk-ghead${pri ? ' pri' : ' sec2'} open" data-g><span class="chev">▾</span><span class="g-lab">${label}</span><span class="g-n">${count}</span></div>`;
}
const buckets = {
  nmSel: '.bk-tail, .bk-name', rowCls: 'bk-row',
  css: `
.bk-ghead{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--sidebar);font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;cursor:pointer;user-select:none}
.bk-ghead.pri{color:var(--seclabel)}
.bk-ghead.sec2{color:var(--muted)}
.bk-ghead .g-n{margin-left:auto;color:var(--muted);font-weight:400}
.bk-ghead .chev{font-size:8px}
.bk-gbody.collapsed{display:none}
.bk-row{display:block;margin:0 3px;padding:3px 6px;border-radius:6px;cursor:pointer}
.bk-row:hover,.bk-row.foc{background:var(--accent)}
.dim .bk-name{color:var(--muted)}
.bk-l1{display:flex;align-items:center;gap:7px}
.bk-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.bk-pre{color:var(--muted)}
.bk-tail{color:var(--fg)}
.bk-meta{display:none;gap:6px;margin:1px 0 0 15px;font-size:10px;color:var(--muted);overflow-wrap:anywhere}
.bk-acts{display:none;gap:1px;margin-left:15px;align-items:center}
.bk-acts .icobtn{font-size:10px;padding:0 2px}
.bk-row:hover .bk-meta,.bk-row:focus-within .bk-meta{display:flex}
.bk-row:hover .bk-acts{display:flex}
.bk-fam{margin-left:10px;border-left:1px solid var(--border2)}
.bk-fhead{display:flex;align-items:center;gap:6px;margin:0 8px;padding:2px 6px;font-size:10px;color:var(--muted);cursor:pointer;border-radius:5px}
.bk-fhead:hover{background:var(--accent)}
.bk-fhead .f-n{color:var(--muted)}
`,
  chatRow: bktRow,
  paneRow: (r) => bktRow(r, { full: true }),
  closedRow: (r) => `<div class="bk-row dim"><div class="bk-l1"><span class="dot ring"></span><span class="bk-name" style="color:var(--muted)">${esc(r.name)}</span></div><div class="bk-meta"><span>${r.host}</span><span>${r.time}</span></div></div>`,
  hostRow: (h) => `<div class="hrow"><span class="dot ${h.active ? 'solid' : 'ring'}"></span><span class="nm" style="color:var(--fg)">${h.label}</span>${h.local ? '<span class="tag">local</span>' : `<span class="dot ${h.status === 'online' ? 'solid' : 'sq'}" title="${h.status}"></span>`}<span class="n">${h.active || ''}</span><span class="arr">›</span></div>`,
  sessionRow: (s) => `<div class="bk-row"><div class="bk-l1"><span class="bk-name" style="font-size:11.5px" title="${esc(s.sum)} — click to resume">${esc(s.sum)}</span></div><div class="bk-meta"><span>${s.meta}</span></div>${s.tag ? `<div class="sesstag" style="padding:2px 0 0 15px"><span class="tg on">${s.tag}</span></div>` : ''}</div>`,
};

/* ------------------------------ section builders ------------------------------ */
function header({ root = false, back = null, title = null, count = 8, on = false } = {}) {
  return `<div class="shead">${back !== null ? '<span class="icobtn" title="back">‹</span>' : ''}${title ? `<span class="lab">${title}</span>` : root ? '<span class="lab">open</span>' : ''}<input placeholder="filter…" aria-label="filter"><span class="icobtn${on ? ' on' : ''}" title="filter &amp; sort">${ICON(I.sliders, 'ica', 12)}</span><span class="cnt">${count}</span><span class="ago">2m ago</span><span class="icobtn" title="refresh">↻</span></div>`;
}
function spawnForm() {
  return `<div class="spawn"><span class="sel">host ▾</span><span class="cwd">~/warden</span><input class="prompt" placeholder="prompt…" aria-label="spawn prompt"><button class="go" title="spawn">+</button></div>`;
}
function sourceControl(expanded) {
  return `<div class="sc">
  <button class="schead" data-g><span class="chev">${expanded ? '▾' : '▸'}</span>${ICON(I.branch, 'ica', 11)}<span>feat/sidebar-density</span><span class="scbits"><span class="add">${SC.diff}</span><span>↑${SC.ahead}</span><span title="stashed WIP (1)">≡${SC.stash}</span></span></button>
  ${expanded ? `<div class="scbody">
    <div class="fgroup">staged changes</div>${SC.staged.map(f => `<div class="file"><span class="st ${f.s[0]}">${f.s}</span><span>${esc(f.p)}</span></div>`).join('')}
    <div class="fgroup">changes</div>${SC.changes.map(f => `<div class="file"><span class="st ${f.s[0] === '?' ? 'Q' : f.s[0]}">${f.s}</span><span>${esc(f.p)}</span></div>`).join('')}
    <div class="fgroup">recent commits</div>${SC.commits.map(c => `<div class="commit"><span class="h">${c.h}</span><span class="s">${esc(c.s)}</span><span class="t">${c.t}</span></div>`).join('')}
  </div>` : ''}
</div>`;
}
function hostsSection(D, offlineCollapsed = true) {
  return `<div class="secrow"><span class="sec" style="padding:0">collections</span><span class="icobtn" style="margin-left:auto" title="new collection">+</span></div>
  ${COLLECTIONS.map(c => `<div class="hrow">${ICON(I.grid, 'ica', 11)}<span class="nm" style="color:var(--fg)">${c.name}</span><span class="n">${c.n}</span><span class="arr">›</span></div>`).join('')}
  <div class="hdiv"></div>
  <div class="sec">hosts</div>
  ${HOSTS.filter(h => h.status !== 'offline').map(D.hostRow).join('')}
  <div class="offline-t" data-g><span class="chev">${offlineCollapsed ? '▸' : '▾'}</span><span class="dot sq" style="width:7px;height:7px"></span><span>offline (1)</span></div>
  ${offlineCollapsed ? '' : HOSTS.filter(h => h.status === 'offline').map(D.hostRow).join('')}`;
}
function rootView(D, bucketed = false) {
  const open = OPEN_PANES.map(D.paneRow).join('');
  const closed = CLOSED.slice(0, 3).map(D.closedRow).join('');
  const openSec = bucketed
    ? `${groupHead('● open panes', 8, true, true)}<div class="bk-gbody">${open}</div>`
    : `<div class="sec pri">● open panes</div>${open}`;
  const closedSec = bucketed
    ? `${groupHead('recently closed', 5)}<div class="bk-gbody">${closed}</div>`
    : `<div class="hdiv"></div><div class="sec">recently closed</div>${closed}<div class="icobtn" style="margin:2px 10px;font-size:10.5px">show 2 more</div>`;
  return `${header({ root: true, count: 8 })}${spawnForm()}<div class="sb">${sourceControl(false)}
  ${openSec}
  ${closedSec}${bucketed ? '' : ''}
  <div class="secrow"><span class="icobtn" style="color:#79b8ff;padding:2px 4px">↗</span><span style="font-size:11.5px;color:#79b8ff">Open chat…</span></div>
  ${hostsSection(D)}
  <div style="height:8px"></div>
</div>`;
}
function hostView(D, bucketed = false) {
  const withMeta = (r) => ({ type: 'claude', host: 'build-farm-01', ...r });
  let listHtml;
  if (bucketed) {
    const fam = HOST_CHATS.live.slice(0, 18).map(r => D.chatRow(withMeta(r), { full: true, tailOnly: true })).join('');
    const named = HOST_CHATS.live.slice(18).map(r => D.chatRow(withMeta(r), { full: true })).join('');
    const idle = HOST_CHATS.idle.map(r => D.chatRow(withMeta(r), { full: true })).join('');
    listHtml = `${groupHead('● live (tmux)', 21, true, true)}<div class="bk-gbody">
      <div class="bk-fhead" data-g><span class="chev">▾</span><span><span class="bk-pre">chat-</span><span class="f-n">… × 18</span></span></div>
      <div class="bk-gbody bk-fam">${fam}</div>
      ${named}</div>
      ${groupHead('idle', 14)}<div class="bk-gbody">${idle}</div>`;
  } else {
    listHtml = `<div class="sec pri">● live (tmux)</div>${HOST_CHATS.live.map(r => D.chatRow(withMeta(r), { full: true })).join('')}
      <div class="sec">idle</div>${HOST_CHATS.idle.map(r => D.chatRow(withMeta(r), { full: true })).join('')}`;
  }
  return `${header({ back: true, title: 'build-farm-01', count: 35, on: true })}
<div class="sb">${listHtml}
  <div class="hdiv"></div>
  <div class="secrow"><span class="sec cyan" style="padding:0">${ICON(I.cloud, 'ica', 12)} sessions (history — click to resume)</span><span style="font-size:10px;color:var(--muted)">5.2M</span></div>
  <div class="sesstag"><span class="tg on">wip</span><span class="tg">infra</span><span class="tg add">+ tag</span><span class="tg" style="border:none;color:var(--muted)">clear</span></div>
  ${SESSIONS.map(D.sessionRow).join('')}
  <div class="icobtn" style="margin:2px 10px;font-size:10.5px">show 34 more</div>
</div>
<div class="selbar"><b>3</b> selected<button>All</button><button>Send</button><button>Interrupt</button><button>Watch</button><button class="red">Kill</button><span class="icobtn" style="margin-left:auto">✕</span></div>`;
}
function collectionView(D) {
  return `${header({ back: true, title: 'release train', count: 9 })}
<div class="sb"><div class="mini-note">agents shortlisted for the 0.1.75 release</div>
  <div class="sec pri">● matching agents</div>
  ${COLL_AGENTS.filter(a => a.state !== 'idle').map(a => D.chatRow({ type: 'claude', host: 'build-farm-01', ...a }, { full: true })).join('')}
  <div class="sec">idle</div>
  ${COLL_AGENTS.filter(a => a.state === 'idle').map(a => D.chatRow({ type: 'claude', host: 'build-farm-01', ...a }, { full: true })).join('')}
</div>
<div class="selbar"><span>selection actions</span><button>All</button><button>Send</button><button>Interrupt</button><button>Watch</button><button class="red">Kill</button></div>`;
}
function rowsMatrix(D) {
  const R = (label, row) => `<div class="matrixlab">${label}</div>${row}`;
  const mk = (over) => D.chatRow({ type: 'claude', host: 'build-farm-01', time: '22m', ...over }, { full: true });
  const rowCls = D === ledger ? 'led-row foc' : D === buckets ? 'bk-row foc' : 'ik-row foc';
  const nameCls = D === ledger ? 'led-namewrap' : D === buckets ? 'bk-name' : 'ik-name';
  return `<div class="sb" style="padding-bottom:14px">
  ${R('focused · open', mk({ name: 'planner yatfa', type: 'yatfa', role: 'planner', host: 'this machine', state: 'open', focused: true }))}
  ${R('open', mk({ name: 'refactor chat resolution', state: 'open' }))}
  ${R('active agent (◐)', mk({ name: 'fix sidebar wrap', state: 'active', watch: 'ok' }))}
  ${R('idle', mk({ name: 'cache warm', state: 'idle' }))}
  ${R('closed — recently closed row', D.closedRow({ name: 'chat-b6m4sq', host: 'build-farm-01', time: '1h' }))}
  ${R('dead pane', `<div class="${rowCls}">${stateDot({ state: 'dead' })}<span class="${nameCls}" style="text-decoration:line-through;color:var(--muted)">${esc('index rebuild')}</span><span style="font-size:10px;color:#ff8f88;margin-left:auto;flex:none">▪ dead</span></div>`)}
  ${R('watched — needs you (stuck · pulsing)', mk({ name: 'chat-4nh15o', watch: 'stuck' }))}
  ${R('watched — needs you (pattern match)', mk({ name: 'chat-6hu58k', watch: 'custom' }))}
  ${R('being renamed', `<div class="${rowCls}">${stateDot({ state: 'open' })}<input class="rename" value="perf run nightly" aria-label="rename"></div>`)}
  ${R('carrying a note', mk({ name: 'perf run nightly', note: 'compare against 0.1.72 baseline' }))}
  ${R('pinned', mk({ name: 'bug triage', pinned: true }))}
  ${R('agent-owned (yatfa — not renameable)', mk({ name: 'worker yatfa', type: 'yatfa', role: 'worker', host: 'this machine', state: 'active' }))}
  ${R('user-owned (host tag)', mk({ name: 'docs pass', host: 'gpu-node-02' }))}
  ${R('hover — actions revealed (this row shows the hover state; the row below is live)', `<div class="force-hover">${mk({ name: 'chat-mo71sw', note: 'owner: yatfa-worker' })}</div>`)}
  ${R('(live hover target)', mk({ name: 'docs pass' }))}
</div>`;
}
function statesView() {
  const skel = `${[1, 2, 3, 4].map(() => `<div class="skel-row"><span class="skel dotp"></span><span class="skel grow"></span><span class="skel w12"></span></div>`).join('')}`;
  return `<div class="sb">
  <div class="pairlabel" style="margin:10px 0 4px 2px">loading — skeleton rows</div>${skel}
  <div class="hdiv"></div>
  <div class="pairlabel">empty — no open panes</div>
  <div class="empty">${ICON(I.folder, '', 18)}<span class="t">No open panes</span><span class="d">Open a chat or resume a session below</span></div>
  <div class="hdiv"></div>
  <div class="pairlabel">no match for filter — "cache"</div>
  <div class="nomatch">no panes match "cache" — <a>clear filter</a></div>
  <div class="hdiv"></div>
  <div class="pairlabel">host unreachable — unknown, not empty</div>
  <div class="err">× could not reach staging-pi — connection timed out. Sessions on this host are unknown, not absent. <a>retry</a></div>
</div>`;
}
function filterView(D) {
  const rows = HOST_CHATS.live.concat(HOST_CHATS.idle).map(r => ({ type: 'claude', host: 'build-farm-01', ...r }));
  return `<div class="filterbox"><input class="flt-in" value="4nh" aria-label="filter the list" spellcheck="false"><div class="fc flt-cnt"></div></div>
<div class="sb flt-list">${rows.map(r => D.chatRow(r, { full: true })).join('')}</div>
<div class="nomatch flt-none" style="display:none">no agents match the current filter — <a class="flt-clear">clear filter</a></div>`;
}

/* ------------------------------ page assembly ------------------------------ */
const TABS = [['root', 'root'], ['host', 'host'], ['collection', 'collection'], ['rows', 'row conditions'], ['states', 'loading · empty · no match'], ['sc', 'source control'], ['filter', 'filter applied']];
function page(D, title) {
  const colhead = `<div class="colhead"><span>narrow · 208 px</span><span>comfortable · 320 px</span></div>`;
  const pair = (html, tall = false) => `<div class="stage"><div class="panel${tall ? ' tall' : ''}">${html}</div><div class="panel${tall ? ' tall' : ''}">${html}</div></div>`;
  const sections = {
    root: pair(rootView(D, D === buckets)),
    host: pair(hostView(D, D === buckets)),
    collection: pair(collectionView(D)),
    rows: pair(rowsMatrix(D), true),
    states: pair(statesView()),
    sc: `<div class="pairrow"><div class="pairlabel">collapsed</div><div class="stage">${['', ''].map(() => `<div class="panel tall"><div class="sb" style="padding:8px 4px">${sourceControl(false)}</div></div>`).join('')}</div></div>
          <div class="pairlabel">expanded — working tree, diffstat, recent commits (scoped to the focused pane)</div><div class="stage">${['', ''].map(() => `<div class="panel tall"><div class="sb" style="padding:8px 4px">${sourceControl(true)}</div></div>`).join('')}</div>`,
    filter: pair(filterView(D)),
  };
  const tabsHtml = TABS.map(([k, lab], i) => `<button data-t="${k}" class="${i === 0 ? 'on' : ''}">${lab}</button>`).join('');
  const sectionsHtml = TABS.map(([k], i) => `<section class="tab ${i === 0 ? 'on' : ''}" data-tab="${k}">${colhead}${sections[k]}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WARDEN-1403 · ${title}</title><style>${BASE_CSS}${D.css}
.force-hover .ik-row,.force-hover .led-row,.force-hover .bk-row{background:var(--accent)}
.force-hover .ik-badges,.force-hover .ik-acts{display:flex}
.force-hover .ik-time{display:none}
.force-hover .led-gut{display:none}
.force-hover .led-acts{display:flex}
.force-hover .bk-meta,.force-hover .bk-acts{display:flex}
</style></head><body><div class="page">
<div class="topbar"><h1>Warden sidebar redesign — ${title}</h1><span class="sub">state matrix · every view at 208 px and 320 px</span></div>
<nav class="tabs">${tabsHtml}</nav>
${sectionsHtml}
</div><script>
(function(){
  document.querySelectorAll('.tabs button').forEach(function(b){b.addEventListener('click',function(){
    document.querySelectorAll('.tabs button').forEach(function(x){x.classList.remove('on')});b.classList.add('on');
    document.querySelectorAll('section.tab').forEach(function(s){s.classList.toggle('on',s.dataset.tab===b.dataset.t)});
  });});
  document.addEventListener('click',function(e){
    var h=e.target.closest('[data-g]');if(!h)return;
    var open=h.classList.toggle('open');
    var ch=h.querySelector('.chev');if(ch)ch.textContent=open?'▾':'▸';
    var body=h.nextElementSibling;
    if(body&&body.classList.contains('bk-gbody'))body.classList.toggle('collapsed',!open);
    if(h.classList.contains('offline-t')&&body)body.style.display=open?'':'none';
  });
  document.querySelectorAll('.filterbox').forEach(function(box){
    var inp=box.querySelector('.flt-in'),list=box.nextElementSibling,cnt=box.querySelector('.flt-cnt'),none=list.nextElementSibling;
    var nmSels='${D.nmSel}'.split(',').map(function(s){return s.trim()});
    function nameEl(r){for(var i=0;i<nmSels.length;i++){var el=r.querySelector(nmSels[i]);if(el)return el;}return null;}
    function run(){
      var q=inp.value.trim().toLowerCase();
      var n=0,total=0;
      [].slice.call(list.children).forEach(function(r){
        if(!r.classList.contains('${D.rowCls}'))return;
        total++;
        var el=nameEl(r);
        if(el){if(el._orig===undefined)el._orig=el.innerHTML;el.innerHTML=el._orig;}
        var nm=(el?el.textContent:r.textContent).toLowerCase();
        var hit=!q||nm.indexOf(q)>=0;
        r.style.display=hit?'':'none';
        var nb=r.nextElementSibling;
        if(nb&&nb.classList.contains('note-sub'))nb.style.display=hit?'':'none';
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
      cnt.textContent=q?n+' of '+total+' match "'+inp.value.trim()+'"':total+' rows — type to filter';
      none.style.display=n?'none':'';
    }
    inp.addEventListener('input',run);run();
    none.querySelector('.flt-clear').addEventListener('click',function(){inp.value='';run();inp.focus();});
  });
})();
</script></body></html>`;
}

for (const [dir, D, title] of [
  ['ink', ink, 'Ink — identity chips, two-line rows'],
  ['ledger', ledger, 'Ledger — dense single-line rows'],
  ['buckets', buckets, 'Buckets — grouped, collapsible, filtered'],
]) {
  mkdirSync(new URL(`./${dir}/`, import.meta.url), { recursive: true });
  writeFileSync(new URL(`./${dir}/index.html`, import.meta.url), page(D, title));
}
console.log('built: ink/index.html ledger/index.html buckets/index.html');

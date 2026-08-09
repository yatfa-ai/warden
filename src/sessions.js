// Persisted observer conversations: each session is a JSON file (LLM messages,
// for replay/resume) + a human-readable markdown transcript. Under ~/.yatfa-warden/sessions/.
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import {
  atomicWrite, atomicWriteJson, atomicAppend, removeFile, readJsonDefensive, readJsonDefensiveSync,
} from './persist.js';

const DIR = path.join(os.homedir(), '.yatfa-warden', 'sessions');
const jsonPath = (id) => path.join(DIR, `${id}.json`);
const mdPath = (id) => path.join(DIR, `${id}.md`);
const ensureDir = () => fs.promises.mkdir(DIR, { recursive: true });

// Async + durable (WARDEN-831): JSON files are written atomically (temp + fsync +
// rename) and read defensively (a corrupt session file is backed up, never silently
// swallowed); the markdown transcript is append-only so a torn write costs at most
// the final block. None of this blocks the event loop on a request path.
export async function listSessions() {
  await ensureDir();
  const out = [];
  let files;
  try {
    files = await fs.promises.readdir(DIR);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    // Defensive read per file: a corrupt session is backed up (WARDEN-831) and
    // skipped from the index rather than crashing the list.
    const j = await readJsonDefensive(path.join(DIR, f), { fallback: null });
    if (!j) continue;
    out.push({
      id: j.id, name: j.name,
      createdAt: j.createdAt, updatedAt: j.updatedAt,
      messageCount: (j.messages || []).length,
      // NEW: include chat context
      host: j.host || null, container: j.container || null, project: j.project || null, role: j.role || null, chatKey: j.chatKey || null,
    });
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

// SYNC (justified — WARDEN-831): the only caller is the Observer constructor
// (observer.js), which cannot await. This reads ONE small session JSON, once per
// observer-connection start — a bounded, sub-millisecond read that is NOT on a
// hot/poll path and cannot re-stall /api/config (the WARDEN-828 spinner was caused
// by large JSONL reads, now async). It is still DEFENSIVE: a corrupt session file
// is backed up rather than silently swallowed. (If a future caller needs this on a
// hot path, add an async twin instead of widening this one.)
export function getSession(id) {
  return readJsonDefensiveSync(jsonPath(id), { fallback: null });
}

export async function createSession(name, { host, container, project, role, chatKey } = {}) {
  await ensureDir();
  const id = randomBytes(6).toString('hex');
  const now = Date.now();
  const s = {
    id, name: name || `session ${id.slice(0, 4)}`, createdAt: now, updatedAt: now, messages: [],
    // NEW: chat context metadata
    host: host || null, container: container || null, project: project || null, role: role || null, chatKey: chatKey || null,
  };
  // Write the JSON atomically first (the source of truth), then the human-readable
  // stub. Order matters: a crash here leaves no session JSON rather than a partial
  // one, and listSessions/getSession key off the JSON file.
  await atomicWriteJson(jsonPath(id), s);
  await atomicWrite(mdPath(id), `# ${s.name}\n\n`);
  return s;
}

export async function renameSession(id, name) {
  const s = await getSession(id);
  if (!s) return null;
  s.name = name;
  s.updatedAt = Date.now();
  await atomicWriteJson(jsonPath(id), s);
  // Rename the md heading too (best-effort — a missing/unreadable md is ignored).
  try {
    const md = await fs.promises.readFile(mdPath(id), 'utf8');
    await atomicWrite(mdPath(id), md.replace(/^# .*/m, `# ${name}`));
  } catch { /* md missing or unreadable — ignore */ }
  return s;
}

export async function deleteSession(id) {
  await removeFile(jsonPath(id));
  await removeFile(mdPath(id));
}

// Persist the raw LLM message history (so a reconnect resumes the conversation).
export async function saveMessages(id, messages, name) {
  const prev = await getSession(id);
  const now = Date.now();
  const out = {
    id,
    name: name || prev?.name || id,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
    messages,
    // NEW: preserve chat context from previous session
    host: prev?.host || null, container: prev?.container || null, project: prev?.project || null, role: prev?.role || null, chatKey: prev?.chatKey || null,
  };
  await ensureDir();
  await atomicWriteJson(jsonPath(id), out);
  return out;
}

// Append a human-readable block to the markdown transcript (append-only — WARDEN-831).
export async function appendTranscript(id, role, text) {
  const md = mdPath(id);
  const who = role === 'user' ? '🧑 user' : role === 'assistant' ? '🤖 observer' : role;
  // Initialize the heading on first write (matches the prior existsSync guard).
  let header = '';
  try { await fs.promises.access(md); } catch { header = `# ${role}\n\n`; }
  await atomicAppend(md, `${header}\n## ${new Date().toISOString()} — ${who}\n\n${text}\n`);
}

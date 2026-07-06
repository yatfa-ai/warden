// Persisted observer conversations: each session is a JSON file (LLM messages,
// for replay/resume) + a human-readable markdown transcript. Under ~/.yatfa-warden/sessions/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

const DIR = path.join(os.homedir(), '.yatfa-warden', 'sessions');
const jsonPath = (id) => path.join(DIR, `${id}.json`);
const mdPath = (id) => path.join(DIR, `${id}.md`);
const ensure = () => fs.mkdirSync(DIR, { recursive: true });

export function listSessions() {
  ensure();
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      out.push({
        id: j.id, name: j.name,
        createdAt: j.createdAt, updatedAt: j.updatedAt,
        messageCount: (j.messages || []).length,
      });
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

export function getSession(id) {
  try { return JSON.parse(fs.readFileSync(jsonPath(id), 'utf8')); } catch { return null; }
}

export function createSession(name) {
  ensure();
  const id = randomBytes(6).toString('hex');
  const now = Date.now();
  const s = { id, name: name || `session ${id.slice(0, 4)}`, createdAt: now, updatedAt: now, messages: [] };
  fs.writeFileSync(jsonPath(id), JSON.stringify(s, null, 2));
  fs.writeFileSync(mdPath(id), `# ${s.name}\n\n`);
  return s;
}

export function renameSession(id, name) {
  const s = getSession(id);
  if (!s) return null;
  s.name = name;
  s.updatedAt = Date.now();
  fs.writeFileSync(jsonPath(id), JSON.stringify(s, null, 2));
  // rename the md too (best effort)
  try { fs.writeFileSync(mdPath(id), fs.readFileSync(mdPath(id), 'utf8').replace(/^# .*/m, `# ${name}`)); } catch {}
  return s;
}

export function deleteSession(id) {
  try { fs.unlinkSync(jsonPath(id)); } catch { /* noop */ }
  try { fs.unlinkSync(mdPath(id)); } catch { /* noop */ }
}

// Persist the raw LLM message history (so a reconnect resumes the conversation).
export function saveMessages(id, messages, name) {
  const prev = getSession(id);
  const now = Date.now();
  const out = {
    id,
    name: name || prev?.name || id,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
    messages,
  };
  ensure();
  fs.writeFileSync(jsonPath(id), JSON.stringify(out, null, 2));
  return out;
}

// Append a human-readable line to the markdown transcript.
export function appendTranscript(id, role, text) {
  ensure();
  const md = mdPath(id);
  if (!fs.existsSync(md)) fs.writeFileSync(md, `# ${role}\n\n`);
  const who = role === 'user' ? '🧑 user' : role === 'assistant' ? '🤖 observer' : role;
  fs.appendFileSync(md, `\n## ${new Date().toISOString()} — ${who}\n\n${text}\n`);
}

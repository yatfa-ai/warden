// Yatfa Warden observer — the "meta chat". An LLM agent (GLM via Anthropic API) that
// watches the yatfa agent chats through the warden control plane, discusses them
// with the user, and composes directives. Sends are draft-then-confirm: every
// send_directive is intercepted by a human gate before reaching a live agent.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverAll, capturePanes, resolveChat } from './chats.js';
import { read as readPane, send as sendPane } from './tmux.js';
import { complete } from './llm.js';
import { getSession, saveMessages, appendTranscript } from './sessions.js';

const DIRECTIVES_LOG = path.join(os.homedir(), '.yatfa-warden', 'directives.md');

const SYSTEM = `You are Yatfa Warden — an observer and orchestrator for several yatfa software agents. Each agent runs as a "chat" in a remote tmux session (a planner / worker / reviewer / researcher). You watch them and help the human direct them.

You operate ONLY through these tools:
- list_chats(): discover every agent chat + whether it is active (running its TUI) or idle.
- read_chat({id, lines}): read an agent's current terminal pane. ALWAYS read before you advise on a specific agent — never assume.
- send_directive({id, directive}): propose a message to an agent. The user MUST approve every send; you propose and wait for the gate.
- summarize_chats(): read all open tabs in one efficient batch. Use this when the user asks "what's happening", "what are they working on", or you need a complete picture to advise well. Returns pane content + metadata for every open chat.
- suggest_next_actions(): analyze all open agent tabs and suggest prioritized next actions. Classifies agent states (stuck, erroring, waiting, blocked, idle, active) and returns actionable suggestions with urgency levels. Use this to quickly identify which agents need attention.

Your job:
1. Watch — read the chats the user cares about; keep an accurate, current picture of each agent's work.
2. Advise — tell the user what's going on: who is progressing, who is stuck, who is idle, what needs a human decision right now. Be concrete and brief; cite what you read.
3. Direct — when the user wants action, compose a PROPER directive and send it to the right agent via send_directive.

A "proper" directive is a self-contained message addressed to the receiving agent, including: the goal, any context it may lack (paths, ticket ids, decisions), any constraints, and a "done when" condition. Write it as clear natural instructions to that agent — not a rigid template. One focused directive per send.

Rules:
- Never claim you sent something without calling send_directive (and the gate approving).
- Never fabricate an agent's state — call read_chat first.
- Chats marked "open": true in list_chats are the ones the user is actively watching (open panes).
  ONLY read those by default. If the user asks about others, read them on request.
- Do NOT read every chat on every turn. Read only the open ones, and only when needed.
- If you're unsure which agent or what exactly to send, ask the user.
- Keep your own replies to the user concise.

When using summarize_chats, synthesize insights not raw dumps:
- What each agent is actively working on (goal, progress, current step)
- Actionable states: stuck agents (repeating output, errors), idle agents (waiting for input), completed tasks
- Coordination needs: which agents depend on others, workflow bottlenecks
- Human attention needed: decisions, approvals, failures, unexpected states

Be concise. Highlight what needs attention NOW.`;

export const TOOLS = [
  {
    name: 'list_chats',
    description: 'List all agent chats across configured hosts with their active/idle status and role.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_chat',
    description: "Read an agent chat's current terminal pane to see what it is doing. id is any unique substring (container name, project, or role). lines = scrollback lines (default 120).",
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' }, lines: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'send_directive',
    description: 'Propose sending a directive to an agent. The user must approve before it is actually sent. id is any unique substring. directive is the full message text to deliver to the agent.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' }, directive: { type: 'string' } },
      required: ['id', 'directive'],
    },
  },
  {
    name: 'summarize_chats',
    description: 'Read all open tabs at once and synthesize what each agent is working on. Returns pane captures and metadata for every open chat. Use this to get a complete picture of current agent activity before advising the user.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'suggest_next_actions',
    description: 'Analyze all open agent tabs and suggest prioritized, concrete next actions for the human. Classifies agent states (stuck, erroring, waiting, blocked, idle, active) and identifies urgent issues requiring immediate attention.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

function logDirective(chat, text) {
  fs.mkdirSync(path.dirname(DIRECTIVES_LOG), { recursive: true });
  const header = fs.existsSync(DIRECTIVES_LOG) ? '' : '# Yatfa Warden directives log\n';
  const ts = new Date().toISOString();
  const entry = `${header}\n## ${ts} → ${chat.container}@${chat.host} (${chat.role || 'agent'})\n\n${text}\n`;
  fs.appendFileSync(DIRECTIVES_LOG, entry);
}

export class Observer {
  constructor(cfg, { sid, gate, onTool, onToolResult, onText } = {}) {
    this.cfg = cfg;
    this.sid = sid || null;
    // gate: async (chat, directive) => { approved: boolean, edited?: string }
    this.gate = gate;
    // onTool: optional (name, input) => void  for UI tracing
    this.onTool = onTool;
    // onToolResult: optional (name, result) => void  for handling tool results
    this.onToolResult = onToolResult;
    // onText: optional (text) => void  streams assistant text emitted mid-loop
    this.onText = onText;
    this.lastChats = [];
    // resume an existing persisted conversation (if any)
    const existing = sid ? getSession(sid) : null;
    this.name = existing?.name || null;
    this.messages = existing?.messages || [];
  }

  // Reconstruct a UI-visible conversation from the raw LLM message history.
  serializeForUi() {
    const items = [];
    for (const m of this.messages) {
      if (m.role === 'user') {
        if (typeof m.content === 'string') items.push({ role: 'user', text: m.content });
        // tool_result blocks (array content) are skipped in the UI history
      } else if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'text' && b.text) items.push({ role: 'assistant', text: b.text });
          else if (b.type === 'tool_use') items.push({ role: 'tool', name: b.name, id: (b.input && b.input.id) || '' });
        }
      }
    }
    return items;
  }

  async _refreshChats() {
    const { chats } = await discoverAll(this.cfg.hosts, this.cfg);
    this.lastChats = chats;
    return chats;
  }

  async _resolve(id) {
    const result = resolveChat(id, this.lastChats, null);

    // If we got a definitive result, return it (converting to chat or error object)
    if (result.chat) return result.chat;
    if (result.error) return { error: result.error };

    // No match in cache - refresh and try again
    const chats = await this._refreshChats();
    const result2 = resolveChat(id, chats, null);

    if (result2.chat) return result2.chat;
    if (result2.error) return { error: result2.error };

    // Should not reach here, but just in case
    return { error: `no chat matches "${id}". try one of: ${this.lastChats.map((c) => c.container).join(', ')}` };
  }

  async _execTool(name, input) {
    if (this.onTool) this.onTool(name, input);
    if (name === 'list_chats') {
      const chats = await this._refreshChats();
      const open = new Set(this.openTabs || []);
      return chats.map((c) => ({
        id: c.container || c.session, host: c.host, project: c.project, role: c.role,
        active: c.active, status: c.status,
        open: open.has(c.container || c.session) || open.has(c.key),
      }));
    }
    if (name === 'read_chat') {
      const chat = await this._resolve(input.id);
      if (chat.error) return chat;
      try {
        const pane = await readPane(chat, this.cfg, input.lines || 120);
        return { id: chat.container, host: chat.host, pane: pane.slice(-8000) };
      } catch (e) { return { error: e.message }; }
    }
    if (name === 'send_directive') {
      const chat = await this._resolve(input.id);
      if (chat.error) return chat;
      const decision = await this.gate(chat, input.directive);
      if (!decision.approved) return { sent: false, reason: 'user declined the directive' };
      const text = decision.edited != null ? decision.edited : input.directive;
      try {
        await sendPane(chat, this.cfg, text);
        logDirective(chat, text);
        return { sent: true, to: `${chat.container}@${chat.host}`, chars: text.length };
      } catch (e) { return { error: e.message }; }
    }
    if (name === 'summarize_chats') {
      const open = new Set(this.openTabs || []);
      if (open.size === 0) return { error: 'no tabs are open. open some agent panes first.' };

      // Filter to only open tabs
      const openChats = this.lastChats.filter(c =>
        open.has(c.container || c.session) || open.has(c.key)
      );

      if (openChats.length === 0) {
        return { error: 'open tabs do not match any discovered chats. try refreshing with list_chats.' };
      }

      try {
        // Import capturePanes from server (needs module import at top)
        const panes = await capturePanes(openChats);

        // Return structured result with metadata + panes
        return {
          chats: openChats.map(c => ({
            id: c.container || c.session,
            host: c.host,
            project: c.project,
            role: c.role,
            active: c.active,
            status: c.status,
            pane: panes[c.key] || '(no pane content)',
          })),
          count: openChats.length,
        };
      } catch (e) {
        return { error: e.message };
      }
    }
    if (name === 'suggest_next_actions') {
      const open = new Set(this.openTabs || []);
      if (open.size === 0) return { error: 'no tabs are open. open some agent panes first.' };

      const openChats = this.lastChats.filter(c =>
        open.has(c.container || c.session) || open.has(c.key)
      );

      if (openChats.length === 0) {
        return { error: 'open tabs do not match any discovered chats.' };
      }

      try {
        const panes = await capturePanes(openChats);
        const suggestions = [];

        // Classification patterns (regex-based, no LLM calls)
        const STUCK_RE = /^(.+)\\1\\1/m;
        const ERROR_RE = /error|failed|exception|traceback/i;
        const WAITING_RE = /please|respond|continue\\?|input|press enter/i;
        const BLOCKED_RE = /waiting for|blocked by|depends on/i;

        for (const chat of openChats) {
          const pane = panes[chat.key] || '';
          let state = 'active';
          let urgency = 'informational';
          let action = `Monitoring ${chat.container} activity`;

          if (STUCK_RE.test(pane)) {
            state = 'stuck';
            urgency = 'urgent';
            action = 'Agent appears stuck (repeating output)';
          } else if (ERROR_RE.test(pane)) {
            state = 'erroring';
            urgency = 'urgent';
            action = 'Agent encountered an error';
          } else if (WAITING_RE.test(pane)) {
            state = 'waiting';
            urgency = 'important';
            action = 'Agent is waiting for human input';
          } else if (BLOCKED_RE.test(pane)) {
            state = 'blocked';
            urgency = 'important';
            action = 'Agent is blocked by dependency';
          } else if (!pane.trim() || pane.length < 50) {
            state = 'idle';
            urgency = 'informational';
            action = 'Agent appears idle';
          }

          suggestions.push({
            agentId: chat.key,
            agentName: chat.container || chat.session,
            host: chat.host,
            role: chat.role,
            urgency,
            state,
            action
          });
        }

        // Sort by urgency (urgent → important → informational)
        const urgencyOrder = { urgent: 0, important: 1, informational: 2 };
        suggestions.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

        return { suggestions };
      } catch (e) {
        return { error: e.message };
      }
    }
    return { error: `unknown tool ${name}` };
  }

  // Run one user turn; returns the observer's final text. Tool calls loop internally.
  async step(userText) {
    this.messages.push({ role: 'user', content: userText });
    if (this.sid) appendTranscript(this.sid, 'user', userText);
    let finalText = '';
    for (let i = 0; i < 8; i++) {
      const resp = await complete({ system: SYSTEM, messages: this.messages, tools: TOOLS, max_tokens: 2048 });
      const content = resp.content || [];
      this.messages.push({ role: 'assistant', content });
      const toolUses = content.filter((b) => b.type === 'tool_use');
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!toolUses.length) { finalText = text; break; }
      if (text && this.onText) this.onText(text);
      const results = [];
      for (const tu of toolUses) {
        const out = await this._execTool(tu.name, tu.input || {});
        if (this.onToolResult) this.onToolResult(tu.name, out);
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(out).slice(0, 12000),
        });
      }
      this.messages.push({ role: 'user', content: results });
    }
    if (!finalText) finalText = '(tool loop limit reached — try simplifying your request)';
    if (this.sid) {
      saveMessages(this.sid, this.messages, this.name);
      appendTranscript(this.sid, 'assistant', finalText);
    }
    return finalText;
  }
}

export { DIRECTIVES_LOG };

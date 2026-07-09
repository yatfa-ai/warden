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
- analyze_agents(): detect patterns across all open tabs. Returns structured insights about which agents are stuck, erroring, idle, or need coordination. Use this to answer "what needs attention?" or diagnose workflow issues.
- suggest_next_actions(): analyze all open agent tabs and suggest prioritized, concrete next actions for the human. Classifies agent states (stuck, erroring, waiting, blocked, idle, active) and identifies urgent issues requiring immediate attention. Returns sorted suggestions with urgency levels.

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

When using analyze_agents, prioritize:
1. Stuck agents (repeating output) — need human intervention or restart
2. Erroring agents — surface the error type and suggest next steps
3. Coordination blockers — which agents are waiting on others
4. Idle agents — what input they need to proceed

Be specific. Name the agents, state the problem, and suggest concrete actions.

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
    name: 'analyze_agents',
    description: 'Analyze all open agent tabs for actionable patterns and states. Returns structured insights about stuck agents, errors, idle agents, and coordination needs. Use this when the user asks "what needs attention", "is anyone stuck", or you need to diagnose issues.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'suggest_next_actions',
    description: 'Analyze all open agent tabs and suggest prioritized, concrete next actions for the human. Classifies agent states (stuck, erroring, waiting, blocked, idle, active) and identifies urgent issues requiring immediate attention. Returns sorted suggestions with urgency levels.',
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

// Pure, dependency-injected core of the summarize_chats tool. capturePanes is passed
// in so this logic is unit-testable without SSH/tmux (mock.module is unavailable on
// the project's Node version). Behavior is identical to the inlined tool handler.
export async function summarizeOpenChats(openTabs, lastChats, capturePanes, cfg) {
  const open = new Set(openTabs || []);
  if (open.size === 0) return { error: 'no tabs are open. open some agent panes first.' };

  // Filter to only open tabs
  const openChats = lastChats.filter(c =>
    open.has(c.container || c.session) || open.has(c.key)
  );

  if (openChats.length === 0) {
    return { error: 'open tabs do not match any discovered chats. try refreshing with list_chats.' };
  }

  try {
    const panes = await capturePanes(openChats, cfg);

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

// Pure, dependency-injected core of the suggest_next_actions tool. capturePanes is
// passed in so the classification logic is unit-testable without SSH/tmux
// (mock.module is unavailable on the project's Node version). Behavior is identical
// to the inlined tool handler.
export async function suggestNextActions(openTabs, lastChats, capturePanes, cfg) {
  const open = new Set(openTabs || []);
  if (open.size === 0) return { error: 'no tabs are open. open some agent panes first.' };

  // Filter to only open tabs
  const openChats = lastChats.filter(c =>
    open.has(c.container || c.session) || open.has(c.key)
  );

  if (openChats.length === 0) {
    return { error: 'open tabs do not match any discovered chats. try refreshing with list_chats.' };
  }

  try {
    const panes = await capturePanes(openChats, cfg);

    // Classification patterns (regex-based, no LLM calls).
    // NOTE: BLOCKED_RE is scoped to coordination/dependency language (other agents,
    // external dependencies) — it deliberately does NOT match the bare fragment
    // "waiting for", which would otherwise swallow "waiting for user" (a human-input
    // signal classified as 'waiting' below). The two states stay distinct, matching
    // the ticket spec: waiting = human input, blocked = other agents/dependencies.
    const ERROR_RE = /error|failed|exception|traceback|panic/i;
    const WAITING_RE = /please|respond|continue\?|input|press enter|waiting for user/i;
    const BLOCKED_RE = /blocked by|blocked on|depends on|waiting for (?:the |an |a )?(?:agent|worker|planner|reviewer|researcher|dependency|approval from)/i;
    const ACTIVE_RE = /running|processing|building|installing|downloading|executing|working on|implement/i;

    const suggestions = [];

    for (const c of openChats) {
      const pane = panes[c.key] || '';
      const agentId = c.container || c.session;
      const role = c.role || 'agent';
      const project = c.project || 'unknown';

      let state = 'idle';
      let urgency = 'informational';
      let action = 'No action needed - agent is idle.';

      // Detect repeating output (stuck agent) using line-by-line comparison
      const lines = pane.split('\n');
      const last3 = lines.slice(-3).join('\n');
      const prev3 = lines.slice(-6, -3).join('\n');
      const stuck = last3 === prev3 && last3.length > 50;

      // Classify agent state using regex patterns. BLOCKED is checked before WAITING:
      // because BLOCKED_RE is scoped to coordination signals, no human-input pane can
      // match it, so genuine waiting input always reaches the WAITING branch.
      if (ERROR_RE.test(pane)) {
        state = 'erroring';
        urgency = 'urgent';
        action = `Agent encountered an error. Review the pane content and investigate the failure. Consider sending a directive to retry or fix the issue.`;
      } else if (stuck) {
        state = 'stuck';
        urgency = 'urgent';
        action = `Agent appears stuck (repeating output detected). Interrupt and redirect with a new directive, or terminate if needed.`;
      } else if (BLOCKED_RE.test(pane)) {
        state = 'blocked';
        urgency = 'important';
        action = `Agent is blocked on a dependency. Check what it's waiting for and unblock it, or redirect to other work.`;
      } else if (WAITING_RE.test(pane)) {
        state = 'waiting';
        urgency = 'important';
        action = `Agent is waiting for input. Respond to its request or provide the needed information.`;
      } else if (ACTIVE_RE.test(pane) && c.active) {
        state = 'active';
        urgency = 'informational';
        action = `Agent is actively working. No immediate action needed, but monitor for completion or issues.`;
      } else if (pane.trim().length > 100) {
        state = 'idle';
        urgency = 'informational';
        action = `Agent has output but appears inactive. Check if it completed its task or needs direction.`;
      } else {
        state = 'idle';
        urgency = 'informational';
        action = `Agent is idle with minimal output. Consider assigning work or checking if it needs direction.`;
      }

      suggestions.push({
        agentId: agentId,
        agentName: agentId,
        role,
        project,
        host: c.host,
        state,
        urgency,
        action,
        pane_excerpt: pane.slice(-200).trim(), // Last 200 chars for context
      });
    }

    // Sort by urgency: urgent > important > informational
    const urgencyOrder = { urgent: 0, important: 1, informational: 2 };
    suggestions.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

    return {
      suggestions,
      summary: {
        total: suggestions.length,
        urgent: suggestions.filter(s => s.urgency === 'urgent').length,
        important: suggestions.filter(s => s.urgency === 'important').length,
        informational: suggestions.filter(s => s.urgency === 'informational').length,
      },
    };
  } catch (e) {
    return { error: e.message };
  }
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
      return summarizeOpenChats(this.openTabs, this.lastChats, capturePanes, this.cfg);
    }
    if (name === 'analyze_agents') {
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
        const panes = await capturePanes(openChats, this.cfg);

        const insights = openChats.map(c => {
          const pane = panes[c.key] || '';
          const lines = pane.split('\n');

          // Detect repeating output (stuck agent)
          const last3 = lines.slice(-3).join('\n');
          const prev3 = lines.slice(-6, -3).join('\n');
          const stuck = last3 === prev3 && last3.length > 50;

          // Detect errors
          const hasError = /error|exception|failed|traceback|fatal/i.test(pane);
          const errorLines = lines.filter(l => /error|exception|failed/i.test(l)).slice(-2);

          // Detect idle/waiting
          const isIdle = /prompt|waiting|input|approval|press|continue/i.test(pane);

          // Detect coordination signals
          const mentionsAgent = /agent|worker|planner|reviewer|researcher/i.test(pane);
          const blocked = /blocked|waiting on|depends|need.*from/i.test(pane);

          return {
            id: c.container || c.session,
            host: c.host,
            role: c.role,
            state: stuck ? 'stuck' : (hasError ? 'erroring' : (isIdle ? 'idle' : 'active')),
            signals: {
              stuck,
              hasError,
              errorSample: errorLines.join('; '),
              isIdle,
              mentionsAgent,
              blocked,
            },
          };
        });

        const summary = {
          total: insights.length,
          stuck: insights.filter(i => i.state === 'stuck').length,
          erroring: insights.filter(i => i.state === 'erroring').length,
          idle: insights.filter(i => i.state === 'idle').length,
          active: insights.filter(i => i.state === 'active').length,
        };

        return { insights, summary };
      } catch (e) {
        return { error: e.message };
      }
    }
    if (name === 'suggest_next_actions') {
      return suggestNextActions(this.openTabs, this.lastChats, capturePanes, this.cfg);
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

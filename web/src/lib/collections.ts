// PURE collection-criteria helpers shared by the Collections authoring surface
// (CreateCollectionDialog, CollectionsSection, ChatSidebar) and unit-tested in
// web/collections.test.mjs. Extracted from per-component inline copies so the
// matcher has ONE source of truth — it was previously triplicated across the
// backend (src/collections.js:getAgentsInCollection) and two frontend copies
// (CollectionsSection.countAgentsInCollection + ChatSidebar's open-view filter).
//
// KEEP IN SYNC with src/collections.js — the backend is the persistence +
// matching authority for /api/collections/:id/agents. The matchers here mirror
// it exactly so the card count, the open-view membership list, and the server's
// agent list agree.
//
// These functions are PURE (no React, no I/O) so they transpile + run under Node
// for unit tests — see web/collections.test.mjs (same harness as agentFilter /
// diff / gitStateSummary).

import type { Chat, Collection } from '@/lib/types';

/**
 * Parse a comma-separated custom-criteria text field into a clean string[]:
 * split on commas, trim whitespace, drop empties, and dedupe (first-wins order).
 * Empty / whitespace-only input → [].
 *
 * This is the writable half of the "custom criteria" grouping the Create dialog
 * advertises (WARDEN-553): a chat matches the collection if ANY custom value
 * equals its role, project, host, OR name (see chatMatchesCriteria). Used by
 * CreateCollectionDialog in both create and edit modes; `[]` is omitted from the
 * persisted criteria so an empty field round-trips to "no custom constraint".
 */
export function parseCustomCriteria(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(text ?? '').split(',')) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Does a single chat match a collection's criteria object?
 *
 * Assumes `criteria` is a defined object — callers decide the no-criteria case
 * (CollectionsSection counts a null/undefined criteria as 0; ChatSidebar's open
 * view treats it as "match all"; created collections always persist at least
 * `{}`, so this divergence is moot in practice). Mirrors the backend matcher in
 * src/collections.js:getAgentsInCollection:
 *   - AND across role / project / host (all specified must hold);
 *   - custom is an OR over its values, each compared against the chat's role,
 *     project, host, OR name.
 */
export function chatMatchesCriteria(chat: Chat, criteria: NonNullable<Collection['criteria']>): boolean {
  if (criteria.role && chat.role !== criteria.role) return false;
  if (criteria.project && chat.project !== criteria.project) return false;
  if (criteria.host && chat.host !== criteria.host) return false;
  if (criteria.custom && Array.isArray(criteria.custom) && criteria.custom.length > 0) {
    const customMatch = criteria.custom.some(
      (value) => chat.role === value || chat.project === value || chat.host === value || chat.name === value,
    );
    if (!customMatch) return false;
  }
  return true;
}

/**
 * Count how many agents in `chats` match the collection's criteria. Preserves
 * the original CollectionsSection semantics: a collection with no criteria
 * object at all counts as 0 (in practice createCollection always stores at least
 * `{}`, which then counts every agent via chatMatchesCriteria — "leave all empty
 * to include all agents").
 */
export function countAgentsInCollection(collection: Collection, chats: Chat[]): number {
  if (!collection.criteria) return 0;
  let count = 0;
  for (const chat of chats) {
    if (chatMatchesCriteria(chat, collection.criteria)) count++;
  }
  return count;
}

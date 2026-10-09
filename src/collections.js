// Collections module for organizing agent workforce into user-defined groups.
// Collections persist in ~/.yatfa-warden/collections.json.
import path from 'node:path';
import { dir } from './config.js';
import { atomicWriteJson, readJsonDefensive } from './persist.js';

export const collectionsPath = path.join(dir, 'collections.json');

// Default empty collections list
const DEFAULT_COLLECTIONS = [];

/**
 * Load collections from storage (async + defensive — WARDEN-831). Returns the
 * default empty array if the file is missing or corrupt; a corrupt file is
 * backed up rather than silently swallowed. The revive hook enforces the array
 * shape so a syntactically-valid-but-wrong-type file is recovered, not propagated.
 */
export async function loadCollections() {
  return readJsonDefensive(collectionsPath, {
    fallback: DEFAULT_COLLECTIONS,
    revive: (v) => { if (!Array.isArray(v)) throw new Error('collections.json root is not a JSON array'); return v; },
  });
}

/**
 * Save collections to storage atomically (temp + fsync + rename, async — WARDEN-831).
 * A crash mid-write leaves the previous complete file in place instead of a
 * truncated one.
 */
export async function saveCollections(collections) {
  await atomicWriteJson(collectionsPath, collections);
}

// Serialized read-modify-write (WARDEN-1675). collections.json is a WHOLE-FILE
// document: create/update/delete each load → mutate in memory → saveCollections
// (full atomicWriteJson). Writes are torn-free but not isolated, so overlapping
// requests read the same snapshot and last write wins (5 concurrent creates
// persisted 1; 2 concurrent deletes removed 1; the duplicate-name guard was racy).
// Mirrors mutateCatalog in config.js: every mutation runs through ONE promise
// chain and the read happens INSIDE the critical section so each mutation sees the
// previous one's result. Return a falsy value from `fn` to skip the write. A
// rejecting mutation does not poison later calls (the chain swallows the failure,
// while the returned promise still rejects for THIS caller).
//
// LIMITATION — IN-PROCESS ONLY, same as mutateCatalog: only the server writes
// collections.json (src/cli.js does not import this module), so no cross-process
// ordering is provided and a file lock is deliberately out of scope.
let collectionsChain = Promise.resolve();
export function mutateCollections(fn) {
  const run = collectionsChain.then(async () => {
    const next = await fn(await loadCollections());
    if (next) await saveCollections(next);
    return next;
  });
  collectionsChain = run.catch(() => {});
  return run;
}

/**
 * Generate a unique ID for a new collection.
 */
function generateId() {
  return `coll-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Create a new collection.
 * @param {string} name - Collection name (required, max 60 chars)
 * @param {object} criteria - Matching criteria { role?, project?, host?, custom?[] }
 * @param {object} metadata - Optional metadata { description?, color? }
 * @returns {object} The created collection
 * @throws {Error} If name is invalid or duplicate
 */
export async function createCollection(name, criteria = {}, metadata = {}) {
  const trimmedName = String(name || '').trim().slice(0, 60);
  if (!trimmedName) {
    throw new Error('Collection name is required');
  }

  let newCollection;
  await mutateCollections((collections) => {
    if (collections.some((c) => c.name === trimmedName)) {
      throw new Error(`Collection "${trimmedName}" already exists`);
    }

    const now = Date.now();
    newCollection = {
      id: generateId(),
      name: trimmedName,
      criteria: criteria || {},
      metadata: metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    return [...collections, newCollection];
  });
  return newCollection;
}

/**
 * Update an existing collection.
 * @param {string} id - Collection ID
 * @param {object} updates - Fields to update { name?, criteria?, metadata? }
 * @returns {object} The updated collection
 * @throws {Error} If collection not found or name conflict
 */
export async function updateCollection(id, updates = {}) {
  // Allow-list: only name/criteria/metadata may be changed; every other key in the
  // request body is ignored. A null/non-object body is treated as {}.
  const src = updates && typeof updates === 'object' && !Array.isArray(updates) ? updates : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(src, key);
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // Validate BEFORE touching storage so rejected input never reaches disk. Messages
  // must not contain "not found" (the route maps that to 404; everything else → 400).
  const patch = {};
  if (has('name')) {
    const trimmedName = typeof src.name === 'string' ? src.name.trim().slice(0, 60) : '';
    if (!trimmedName) {
      throw new Error('Collection name is required');
    }
    patch.name = trimmedName;
  }
  if (has('criteria')) {
    if (!isPlainObject(src.criteria)) throw new Error('Collection criteria must be an object');
    patch.criteria = src.criteria;
  }
  if (has('metadata')) {
    if (!isPlainObject(src.metadata)) throw new Error('Collection metadata must be an object');
    patch.metadata = src.metadata;
  }

  let updated;
  await mutateCollections((collections) => {
    const index = collections.findIndex((c) => c.id === id);
    if (index === -1) {
      throw new Error('Collection not found');
    }

    // Name uniqueness on the same trimmed value that gets stored (self excluded).
    if (patch.name !== undefined && collections.some((c) => c.name === patch.name && c.id !== id)) {
      throw new Error(`Collection "${patch.name}" already exists`);
    }

    updated = {
      ...collections[index],
      ...patch,
      id: collections[index].id, // Preserve original ID
      createdAt: collections[index].createdAt, // Preserve creation time
      updatedAt: Date.now(),
    };

    collections[index] = updated;
    return collections;
  });
  return updated;
}

/**
 * Delete a collection.
 * @param {string} id - Collection ID
 * @returns {boolean} True if deleted, false if not found
 */
export async function deleteCollection(id) {
  let deleted = false;
  await mutateCollections((collections) => {
    const filtered = collections.filter((c) => c.id !== id);
    if (filtered.length === collections.length) {
      return undefined; // Not found — skip the write
    }
    deleted = true;
    return filtered;
  });
  return deleted;
}

/**
 * Get agents from a list that match the collection's criteria.
 * @param {object} collection - Collection with criteria
 * @param {Array} allChats - Array of all chat/agent objects
 * @returns {Array} Filtered array of matching agents
 */
export function getAgentsInCollection(collection, allChats = []) {
  if (!collection || !collection.criteria) {
    return [];
  }

  const { criteria } = collection;
  const results = [];

  for (const chat of allChats) {
    let matches = true;

    // Role filter
    if (criteria.role && chat.role !== criteria.role) {
      matches = false;
    }

    // Project filter
    if (matches && criteria.project && chat.project !== criteria.project) {
      matches = false;
    }

    // Host filter
    if (matches && criteria.host && chat.host !== criteria.host) {
      matches = false;
    }

    // Custom filter (array of strings, chat must match at least one)
    if (matches && criteria.custom && Array.isArray(criteria.custom) && criteria.custom.length > 0) {
      const customMatch = criteria.custom.some((value) => {
        // Match against role, project, host, or name
        return (
          chat.role === value ||
          chat.project === value ||
          chat.host === value ||
          chat.name === value
        );
      });
      if (!customMatch) {
        matches = false;
      }
    }

    if (matches) {
      results.push(chat);
    }
  }

  return results;
}

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

  const collections = await loadCollections();
  if (collections.some((c) => c.name === trimmedName)) {
    throw new Error(`Collection "${trimmedName}" already exists`);
  }

  const now = Date.now();
  const newCollection = {
    id: generateId(),
    name: trimmedName,
    criteria: criteria || {},
    metadata: metadata || {},
    createdAt: now,
    updatedAt: now,
  };

  await saveCollections([...collections, newCollection]);
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
  const collections = await loadCollections();
  const index = collections.findIndex((c) => c.id === id);
  if (index === -1) {
    throw new Error('Collection not found');
  }

  // Check name uniqueness if name is being changed
  if (updates.name && updates.name !== collections[index].name) {
    const trimmedName = String(updates.name).trim().slice(0, 60);
    if (collections.some((c) => c.name === trimmedName && c.id !== id)) {
      throw new Error(`Collection "${trimmedName}" already exists`);
    }
  }

  const updated = {
    ...collections[index],
    ...updates,
    id: collections[index].id, // Preserve original ID
    createdAt: collections[index].createdAt, // Preserve creation time
    updatedAt: Date.now(),
  };

  collections[index] = updated;
  await saveCollections(collections);
  return updated;
}

/**
 * Delete a collection.
 * @param {string} id - Collection ID
 * @returns {boolean} True if deleted, false if not found
 */
export async function deleteCollection(id) {
  const collections = await loadCollections();
  const filtered = collections.filter((c) => c.id !== id);
  if (filtered.length === collections.length) {
    return false; // Not found
  }
  await saveCollections(filtered);
  return true;
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

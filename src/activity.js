// Activity event persistence: JSONL log of key events for "while you were away" timeline.
// One JSON line per event, rotated after 7 days to prevent unbounded growth.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.homedir(), '.yatfa-warden');
const FILE = path.join(DIR, 'activity.jsonl');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Ensure directory and file exist
function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, '', 'utf8');
  }
}

// Append an event to the activity log
export function appendEvent(event) {
  ensure();
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event,
  }) + '\n';
  fs.appendFileSync(FILE, line, 'utf8');
}

// Read all events from the log, optionally filtered by timestamp range
export function readEvents({ after, before, limit } = {}) {
  ensure();
  if (!fs.existsSync(FILE)) return [];

  const content = fs.readFileSync(FILE, 'utf8');
  if (!content.trim()) return [];

  const lines = content.trim().split('\n');
  const events = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const ts = new Date(event.timestamp).getTime();

      // Filter by time range
      if (after && ts < after) continue;
      if (before && ts > before) continue;

      events.push(event);
    } catch {
      // Skip malformed lines
    }
  }

  // Sort by timestamp descending (newest first)
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Apply limit if specified
  if (limit && events.length > limit) {
    return events.slice(0, limit);
  }

  return events;
}

// Remove events older than 7 days (called on startup and periodically)
export function rotateEvents() {
  ensure();
  if (!fs.existsSync(FILE)) return 0;

  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const content = fs.readFileSync(FILE, 'utf8');
  if (!content.trim()) return 0;

  const lines = content.trim().split('\n');
  const kept = [];
  let removed = 0;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const ts = new Date(event.timestamp).getTime();
      if (ts >= cutoff) {
        kept.push(line);
      } else {
        removed++;
      }
    } catch {
      // Keep malformed lines for inspection
      kept.push(line);
    }
  }

  // Rewrite the file with only recent events
  fs.writeFileSync(FILE, kept.join('\n') + '\n', 'utf8');
  return removed;
}

// Clear all events (useful for testing or manual reset)
export function clearEvents() {
  ensure();
  fs.writeFileSync(FILE, '', 'utf8');
}

// Get activity statistics since a given timestamp
export function getStatsSince(after) {
  const events = readEvents({ after });
  const stats = {
    total: events.length,
    directive_proposed: 0,
    attached: 0,
    ended: 0,
    error: 0,
    snapshot: 0,
  };

  for (const event of events) {
    const type = event.type;
    if (stats.hasOwnProperty(type)) {
      stats[type]++;
    } else if (type === 'directive_proposed') {
      stats.directive_proposed++;
    }
  }

  return stats;
}

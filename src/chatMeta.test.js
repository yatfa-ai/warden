// Canonical chat-shape contract (WARDEN-272 review #5).
//
// buildChat() is the SINGLE source of the yatfa chat object literal — both the
// default SSH discover path (src/chats.js) and the companion transport
// (src/companion.js) call it, so parity between the two paths is structural
// rather than enforced by a hand-reimplemented copy in a test. This file locks
// the exact shape against hardcoded literal objects (NOT via buildChat itself,
// so a bug in buildChat is caught here, not papered over). It also covers the
// shared sortChats() ordering both paths use.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ROLES, parseContainerName, buildChat, sortChats, parseActivityTimestamp } from './chatMeta.js';

describe('parseContainerName', () => {
  it('splits "{project}-{role}" on the LAST hyphen', () => {
    assert.deepStrictEqual(parseContainerName('myproject-worker'), { project: 'myproject', role: 'worker' });
    // A multi-hyphen project keeps all leading hyphens in the project.
    assert.deepStrictEqual(parseContainerName('multi-dash-project-planner'), {
      project: 'multi-dash-project', role: 'planner',
    });
  });
  it('treats a hyphenless name as a bare project with no role', () => {
    assert.deepStrictEqual(parseContainerName('barename'), { project: 'barename', role: '' });
  });
});

describe('ROLES', () => {
  it('contains the four yatfa roles', () => {
    assert.ok(ROLES.has('planner'));
    assert.ok(ROLES.has('worker'));
    assert.ok(ROLES.has('reviewer'));
    assert.ok(ROLES.has('researcher'));
    assert.ok(!ROLES.has('agent'));
    assert.ok(!ROLES.has(''));
  });
});

describe('buildChat (the shared chat literal — shape locked here)', () => {
  it('produces the exact documented shape for a representative agent', () => {
    // Hardcoded literal — the contract both discovery paths must match. If
    // buildChat drifts (field renamed, default changed, field dropped), this
    // deepStrictEqual catches it directly.
    assert.deepStrictEqual(
      buildChat('prod-1', 'myproject-worker', 'Up 3 hours', '/work/myproject', true, 'agent'),
      {
        id: 'prod-1:myproject-worker',
        key: 'myproject-worker',
        kind: 'yatfa',
        host: 'prod-1',
        container: 'myproject-worker',
        session: 'agent',
        project: 'myproject',
        role: 'worker',
        isAgent: true,
        active: true,
        status: 'Up 3 hours',
        cwd: '/work/myproject',
        lastActivity: null,
      },
    );
  });

  it('isAgent is true only for the four yatfa roles', () => {
    for (const role of ['worker', 'planner', 'reviewer', 'researcher']) {
      assert.strictEqual(buildChat('h', `p-${role}`, '', '', true, 'agent').isAgent, true, `${role} is an agent`);
    }
    // A non-role suffix (or none) is not an agent, but is still a valid chat.
    assert.strictEqual(buildChat('h', 'p-agent', '', '', true, 'agent').isAgent, false);
    assert.strictEqual(buildChat('h', 'p-bridge', '', '', true, 'agent').isAgent, false);
    assert.strictEqual(buildChat('h', 'barename', '', '', true, 'agent').isAgent, false);
  });

  it('id is host-prefixed (the pin/resolution contract); key is the bare name', () => {
    const chat = buildChat('build-host', 'svc-worker', '', '', false, 'agent');
    assert.strictEqual(chat.id, 'build-host:svc-worker');
    assert.strictEqual(chat.key, 'svc-worker');
    assert.strictEqual(chat.container, 'svc-worker');
  });

  it('coerces a missing/empty cwd to undefined (NOT an empty string)', () => {
    assert.strictEqual(buildChat('h', 'p-worker', '', '', true, 'agent').cwd, undefined, "'' -> undefined");
    assert.strictEqual(buildChat('h', 'p-worker', '', '   ', true, 'agent').cwd, undefined, "whitespace -> undefined");
    assert.strictEqual(buildChat('h', 'p-worker', '', undefined, true, 'agent').cwd, undefined, 'undefined -> undefined');
    assert.strictEqual(buildChat('h', 'p-worker', '', null, true, 'agent').cwd, undefined, 'null -> undefined');
  });

  it('trims a real cwd but keeps it (incl. cwd with spaces)', () => {
    assert.strictEqual(buildChat('h', 'p-worker', '', '/a b/c', true, 'agent').cwd, '/a b/c');
    assert.strictEqual(buildChat('h', 'p-worker', '', '  /work/x  ', true, 'agent').cwd, '/work/x');
  });

  it('coerces a missing status to "" but keeps a real status verbatim', () => {
    assert.strictEqual(buildChat('h', 'p-worker', undefined, '', true, 'agent').status, '');
    assert.strictEqual(buildChat('h', 'p-worker', null, '', true, 'agent').status, '');
    assert.strictEqual(buildChat('h', 'p-worker', 'Up 3 hours (healthy)', '', true, 'agent').status, 'Up 3 hours (healthy)');
  });

  it('normalizes active to a strict boolean', () => {
    assert.strictEqual(buildChat('h', 'p-worker', '', '', true, 'agent').active, true);
    assert.strictEqual(buildChat('h', 'p-worker', '', '', false, 'agent').active, false);
    assert.strictEqual(buildChat('h', 'p-worker', '', '', 1, 'agent').active, true);
    assert.strictEqual(buildChat('h', 'p-worker', '', '', 0, 'agent').active, false);
    assert.strictEqual(buildChat('h', 'p-worker', '', '', undefined, 'agent').active, false);
  });

  it('uses the passed session verbatim', () => {
    assert.strictEqual(buildChat('h', 'p-worker', '', '', true, 'agent').session, 'agent');
    assert.strictEqual(buildChat('h', 'p-worker', '', '', true, 'custom').session, 'custom');
  });

  it('always starts lastActivity at null (the activity-capture pass may fill it)', () => {
    assert.strictEqual(buildChat('h', 'p-worker', '', '', true, 'agent').lastActivity, null);
  });
});

describe('sortChats (shared ordering: active first, then by key)', () => {
  it('puts active chats before inactive ones regardless of name', () => {
    const chats = [
      buildChat('h', 'z-worker', '', '', false, 'agent'),
      buildChat('h', 'a-worker', '', '', true, 'agent'),
      buildChat('h', 'm-worker', '', '', true, 'agent'),
    ];
    const keys = sortChats(chats).map((c) => c.key);
    assert.deepStrictEqual(keys, ['a-worker', 'm-worker', 'z-worker']);
  });
  it('breaks ties by key (localeCompare) when active state is equal', () => {
    const chats = [
      buildChat('h', 'c-worker', '', '', false, 'agent'),
      buildChat('h', 'a-worker', '', '', false, 'agent'),
      buildChat('h', 'b-worker', '', '', false, 'agent'),
    ];
    assert.deepStrictEqual(sortChats(chats).map((c) => c.key), ['a-worker', 'b-worker', 'c-worker']);
  });
  it('sorts in place and returns the same array', () => {
    const chats = [
      buildChat('h', 'b', '', '', false, 'agent'),
      buildChat('h', 'a', '', '', false, 'agent'),
    ];
    assert.strictEqual(sortChats(chats), chats, 'returns the same (mutated) array');
  });
  it('handles an empty array', () => {
    assert.deepStrictEqual(sortChats([]), []);
  });
});

// parseActivityTimestamp is the SINGLE timestamp regex BOTH discovery paths use
// (WARDEN-376): the default SSH path (chats.js) and the companion transport
// (companion.js) both call it on the leading pane line, so lastActivity is
// parsed identically by construction. This locks the exact behavior extracted
// from chats.js's former inline parse — the bracketed/unbracketed,
// space/T-separated YYYY-MM-DD HH:MM:SS forms the default path accepted.
describe('parseActivityTimestamp (the shared leading-line timestamp parse)', () => {
  // For every valid form, the helper must return the SAME epoch ms that
  // `new Date(<extracted substring>)` yields — proving it extracts the
  // timestamp substring (stripping any brackets) and parses it, without
  // hardcoding a timezone-dependent constant (both sides use local time).
  const cases = [
    ['[2024-01-15 10:30:00] worker thinking…', '2024-01-15 10:30:00'],   // bracketed, space
    ['2024-06-01 08:15:42 > running step', '2024-06-01 08:15:42'],        // unbracketed, space
    ['2024-06-01T08:15:42', '2024-06-01T08:15:42'],                       // unbracketed, T (ISO)
    ['[2024-06-01T08:15:42]', '2024-06-01T08:15:42'],                     // bracketed, T
    ['noise 2024-03-09 23:59:59 trailing', '2024-03-09 23:59:59'],        // timestamp mid-line
  ];
  for (const [line, ts] of cases) {
    it(`parses "${line.slice(0, 24)}…" -> epoch ms (extracts ${ts})`, () => {
      const got = parseActivityTimestamp(line);
      const want = new Date(ts).getTime();
      assert.ok(Number.isFinite(got), `expected a finite epoch ms, got ${got}`);
      assert.strictEqual(got, want, 'equals new Date(<extracted ts>).getTime()');
      assert.strictEqual(got, new Date(ts).getTime());
    });
  }

  it('returns null when the line carries no parseable timestamp', () => {
    for (const line of [
      'no timestamp here',
      'worker just says things',
      'Jan 15 10:30:00 worker',           // wrong format (no YYYY-MM-DD)
      '2024/01/15 10:30:00',              // slashes, not dashes
      '2024-01-15',                       // date only, no time
      '10:30:00',                         // time only, no date
    ]) {
      assert.strictEqual(parseActivityTimestamp(line), null, `expected null for ${JSON.stringify(line)}`);
    }
  });

  it('returns null for empty / null / undefined / whitespace input', () => {
    assert.strictEqual(parseActivityTimestamp(''), null);
    assert.strictEqual(parseActivityTimestamp('   '), null);
    assert.strictEqual(parseActivityTimestamp('\n\t'), null);
    assert.strictEqual(parseActivityTimestamp(null), null);
    assert.strictEqual(parseActivityTimestamp(undefined), null);
  });

  it('returns null for a syntactically-matching but invalid ISO date (no NaN leaks)', () => {
    // The regex matches (month/day shape is right) but month 13 is impossible;
    // an ISO date-time with no zone rejects it as Invalid Date. The helper must
    // return null rather than stamping NaN into lastActivity.
    assert.strictEqual(parseActivityTimestamp('2024-13-01T10:00:00'), null);
  });
});

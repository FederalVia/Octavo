import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSince } from '../src/mcp.js';

test('list_notes since: spans and dates', () => {
  const now = Date.UTC(2026, 10, 7, 12);
  assert.equal(parseSince('3d', now), now - 3 * 86400e3);
  assert.equal(parseSince('12h', now), now - 12 * 3600e3);
  assert.equal(parseSince('2w', now), now - 14 * 86400e3);
  assert.equal(parseSince('2026-11-01', now), new Date('2026-11-01T00:00:00').getTime());
  assert.equal(parseSince('2026-11-01T10:00:00Z', now), Date.UTC(2026, 10, 1, 10));
  assert.throws(() => parseSince('last tuesday', now), /Couldn't read/);
});

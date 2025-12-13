import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from './LogEntry.js';

test('LogEntry structure', () => {
  const e: LogEntry = { term: 1, command: { op: 'set', key: 'k', value: 'v' }, index: 1 };
  assert.equal(e.term, 1);
  assert.equal(e.index, 1);
  assert.deepEqual(e.command, { op: 'set', key: 'k', value: 'v' });
});

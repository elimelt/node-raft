import test from 'node:test';
import assert from 'node:assert/strict';
import { isRequestVote, isAppendEntries, isInstallSnapshot } from './MessageTypes.js';

test('RequestVote guard validates shape', () => {
  const msg = { type: 'RequestVote', term: 1, candidateId: 'A', lastLogIndex: 0, lastLogTerm: 0 };
  assert.equal(isRequestVote(msg), true);
  assert.equal(isRequestVote({ ...msg, term: undefined }), false);
});

test('AppendEntries guard validates shape', () => {
  const msg = {
    type: 'AppendEntries',
    term: 1,
    leaderId: 'L',
    prevLogIndex: 0,
    prevLogTerm: 0,
    entries: [],
    leaderCommit: 0,
  };
  assert.equal(isAppendEntries(msg), true);
  assert.equal(isAppendEntries({ ...msg, entries: null }), false);
});

test('InstallSnapshot guard validates shape', () => {
  const msg = {
    type: 'InstallSnapshot',
    term: 1,
    leaderId: 'L',
    lastIncludedIndex: 0,
    lastIncludedTerm: 0,
    offset: 0,
    data: new Uint8Array(),
    done: true,
  };
  assert.equal(isInstallSnapshot(msg), true);
  assert.equal(isInstallSnapshot({ ...msg, data: null }), false);
});

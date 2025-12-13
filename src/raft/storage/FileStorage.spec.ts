import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { FileStorage } from './FileStorage.js';
import type { Snapshot } from './Snapshot.js';

function tmpDir(prefix: string) {
  const p = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  return p;
}

test('FileStorage save/load state and log operations', async () => {
  const dir = tmpDir('raft-test');
  await fs.mkdir(dir, { recursive: true });
  const storage = new FileStorage(dir);

  // initial state
  const state = await storage.loadState();
  assert.equal(state.currentTerm, 0);
  assert.equal(state.votedFor, null);
  assert.equal(state.log.length, 0);

  // save state
  state.currentTerm = 2;
  state.votedFor = 'nodeA';
  await storage.saveState(state);
  const state2 = await storage.loadState();
  assert.equal(state2.currentTerm, 2);
  assert.equal(state2.votedFor, 'nodeA');

  // append log entries
  await storage.appendEntries([
    { index: 1, term: 1, command: { op: 'x' } },
    { index: 2, term: 1, command: { op: 'y' } },
  ]);
  assert.equal(await storage.getLastIndex(), 2);
  assert.deepEqual(await storage.getEntry(1), { index: 1, term: 1, command: { op: 'x' } });
  assert.deepEqual(await storage.getEntries(1, 2), [
    { index: 1, term: 1, command: { op: 'x' } },
    { index: 2, term: 1, command: { op: 'y' } },
  ]);

  // delete from index
  await storage.deleteEntriesFrom(2);
  assert.equal(await storage.getLastIndex(), 1);
  assert.equal(await storage.getEntry(2), undefined);
});

test('FileStorage snapshot save/load and log trim', async () => {
  const dir = tmpDir('raft-test');
  await fs.mkdir(dir, { recursive: true });
  const storage = new FileStorage(dir);

  await storage.appendEntries([
    { index: 1, term: 1, command: { op: 'a' } },
    { index: 2, term: 1, command: { op: 'b' } },
    { index: 3, term: 2, command: { op: 'c' } },
  ]);

  const snapData = new Uint8Array([1, 2, 3]);
  await storage.saveSnapshot({
    lastIncludedIndex: 2,
    lastIncludedTerm: 1,
    data: snapData,
    timestamp: Date.now(),
  } as Snapshot);
  const snap = await storage.loadSnapshot();
  assert.ok(snap);
  assert.equal(snap!.lastIncludedIndex, 2);
  assert.equal(snap!.lastIncludedTerm, 1);
  assert.equal(Buffer.from(snap!.data).toString('hex'), '010203');

  // log should retain entries after snapshot index
  assert.equal(await storage.getLastIndex(), 3);
  const entries = await storage.getEntries(1, 3);
  // entries up to index 2 may be trimmed; ensure 3 remains
  const last = entries.find((e) => e.index === 3);
  assert.ok(last);
});

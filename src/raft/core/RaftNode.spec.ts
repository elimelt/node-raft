import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { InMemoryBus } from '../transport/ClusterTransport.js';
import { ClusterTransport } from '../transport/ClusterTransport.js';
import { FileStorage } from '../storage/FileStorage.js';
import { RaftNode } from './RaftNode.js';

class NoopSM {
  async apply(entry: any) {
    return entry;
  }
  async snapshot() {
    return new Uint8Array();
  }
  async restore(_data: Uint8Array) {}
}

function tmpDir(prefix: string) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function makeNode(bus: InMemoryBus, id: string, peers: string[]) {
  const transport = new ClusterTransport(bus);
  const dir = tmpDir(`raft-${id}`);
  await fs.mkdir(dir, { recursive: true });
  const storage = new FileStorage(dir);
  const node = new RaftNode(
    { nodeId: id, peers, electionTimeoutMin: 1000, electionTimeoutMax: 2000 },
    new NoopSM() as any,
    transport,
    storage
  );
  await node.start();
  return { node, transport, storage, dir };
}

test('RequestVote: grant vote when candidate up-to-date', async () => {
  const bus = new InMemoryBus();
  const A = await makeNode(bus, 'A', ['B']);
  const B = await makeNode(bus, 'B', ['A']);

  const resp = await B.transport.sendRPC('A', {
    type: 'RequestVote',
    term: 1,
    candidateId: 'B',
    lastLogIndex: 0,
    lastLogTerm: 0,
  });
  assert.deepEqual(resp, { term: 1, voteGranted: true });
  const stateA = A.node.getState();
  assert.equal(stateA.term, 1);
  assert.equal((await A.storage.loadState()).votedFor, 'B');

  await A.node.stop();
  await B.node.stop();
});

test('RequestVote: deny if term is stale or log not up-to-date', async () => {
  const bus = new InMemoryBus();
  const A = await makeNode(bus, 'A', ['B']);
  const B = await makeNode(bus, 'B', ['A']);

  await B.transport.sendRPC('A', {
    type: 'AppendEntries',
    term: 2,
    leaderId: 'B',
    prevLogIndex: 0,
    prevLogTerm: 0,
    entries: [{ index: 1, term: 2, command: { x: 1 } }],
    leaderCommit: 0,
  });

  const r1 = await B.transport.sendRPC('A', {
    type: 'RequestVote',
    term: 1,
    candidateId: 'B',
    lastLogIndex: 0,
    lastLogTerm: 0,
  });
  assert.deepEqual(r1, { term: 2, voteGranted: false });

  const r2 = await B.transport.sendRPC('A', {
    type: 'RequestVote',
    term: 3,
    candidateId: 'B',
    lastLogIndex: 1,
    lastLogTerm: 1,
  });
  assert.deepEqual(r2, { term: 3, voteGranted: false });

  await A.node.stop();
  await B.node.stop();
});

test('AppendEntries: consistency checks and commit advance', async () => {
  const bus = new InMemoryBus();
  const F = await makeNode(bus, 'F', ['L']);
  const L = await makeNode(bus, 'L', ['F']);

  const ae1 = await L.transport.sendRPC('F', {
    type: 'AppendEntries',
    term: 1,
    leaderId: 'L',
    prevLogIndex: 0,
    prevLogTerm: 0,
    entries: [
      { index: 1, term: 1, command: { a: 1 } },
      { index: 2, term: 1, command: { b: 2 } },
    ],
    leaderCommit: 0,
  });
  assert.deepEqual(ae1, { term: 1, success: true });

  const ae2 = await L.transport.sendRPC('F', {
    type: 'AppendEntries',
    term: 2,
    leaderId: 'L',
    prevLogIndex: 1,
    prevLogTerm: 1,
    entries: [
      { index: 2, term: 2, command: { b: 3 } },
      { index: 3, term: 2, command: { c: 4 } },
    ],
    leaderCommit: 2,
  });
  assert.deepEqual(ae2, { term: 2, success: true });

  const entries = await F.storage.getEntries(1, 3);
  assert.deepEqual(entries, [
    { index: 1, term: 1, command: { a: 1 } },
    { index: 2, term: 2, command: { b: 3 } },
    { index: 3, term: 2, command: { c: 4 } },
  ]);

  const ae3 = await L.transport.sendRPC('F', {
    type: 'AppendEntries',
    term: 1,
    leaderId: 'L',
    prevLogIndex: 3,
    prevLogTerm: 2,
    entries: [],
    leaderCommit: 3,
  });
  assert.deepEqual(ae3, { term: 2, success: false });

  const st = F.node.getState();
  assert.equal(st.commitIndex, 2);

  await F.node.stop();
  await L.node.stop();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { InMemoryBus } from '../../dist/raft/transport/ClusterTransport.js';
import { ClusterTransport } from '../../dist/raft/transport/ClusterTransport.js';
import { FileStorage } from '../../dist/raft/storage/FileStorage.js';
import { RaftNode } from '../../dist/raft/core/RaftNode.js';

class NoopSM {
  async apply(entry) {
    return entry;
  }
  async snapshot() {
    return new Uint8Array();
  }
  async restore() {}
}

function tmpDir(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function makeNode(bus, id, peers) {
  const transport = new ClusterTransport(bus);
  const dir = tmpDir(`raft-${id}`);
  await fs.mkdir(dir, { recursive: true });
  const storage = new FileStorage(dir);
  const node = new RaftNode(
    { nodeId: id, peers, electionTimeoutMin: 1000, electionTimeoutMax: 2000 },
    new NoopSM(),
    transport,
    storage
  );
  await node.start();
  return { node, transport, storage, dir };
}

test('3-node: votes are granted and replication works end-to-end', async () => {
  const bus = new InMemoryBus();
  const A = await makeNode(bus, 'A', ['B', 'C']);
  const B = await makeNode(bus, 'B', ['A', 'C']);
  const C = await makeNode(bus, 'C', ['A', 'B']);

  const rvA = await B.transport.sendRPC('A', {
    type: 'RequestVote',
    term: 1,
    candidateId: 'B',
    lastLogIndex: 0,
    lastLogTerm: 0,
  });
  const rvC = await B.transport.sendRPC('C', {
    type: 'RequestVote',
    term: 1,
    candidateId: 'B',
    lastLogIndex: 0,
    lastLogTerm: 0,
  });
  assert.deepEqual(rvA, { term: 1, voteGranted: true });
  assert.deepEqual(rvC, { term: 1, voteGranted: true });

  const aeA = await B.transport.sendRPC('A', {
    type: 'AppendEntries',
    term: 1,
    leaderId: 'B',
    prevLogIndex: 0,
    prevLogTerm: 0,
    entries: [{ index: 1, term: 1, command: { op: 'set', key: 'x', value: 42 } }],
    leaderCommit: 1,
  });
  const aeC = await B.transport.sendRPC('C', {
    type: 'AppendEntries',
    term: 1,
    leaderId: 'B',
    prevLogIndex: 0,
    prevLogTerm: 0,
    entries: [{ index: 1, term: 1, command: { op: 'set', key: 'x', value: 42 } }],
    leaderCommit: 1,
  });
  assert.deepEqual(aeA, { term: 1, success: true });
  assert.deepEqual(aeC, { term: 1, success: true });

  const entriesA = await A.storage.getEntries(1, 1);
  const entriesC = await C.storage.getEntries(1, 1);
  assert.equal(entriesA.length, 1);
  assert.equal(entriesC.length, 1);
  assert.equal(A.node.getLeader().nodeId, 'B');
  assert.equal(C.node.getLeader().nodeId, 'B');

  await A.node.stop();
  await B.node.stop();
  await C.node.stop();
});

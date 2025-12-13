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

test('followers learn leader and reject client commands', async () => {
  const bus = new InMemoryBus();
  const A = await makeNode(bus, 'A', ['B']);
  const B = await makeNode(bus, 'B', ['A']);

  const hbA = await B.transport.sendRPC('A', {
    type: 'AppendEntries',
    term: 1,
    leaderId: 'B',
    prevLogIndex: 0,
    prevLogTerm: 0,
    entries: [],
    leaderCommit: 0,
  });
  assert.deepEqual(hbA, { term: 1, success: true });
  assert.equal(A.node.getLeader().nodeId, 'B');

  let err;
  try {
    await A.node.submitCommand({ op: 'set', key: 'k', value: 'v' });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error);
  assert.match(err.message, /Not the leader/);

  await A.node.stop();
  await B.node.stop();
});

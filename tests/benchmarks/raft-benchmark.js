import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { InMemoryBus } from '../../dist/raft/transport/ClusterTransport.js';
import { ClusterTransport } from '../../dist/raft/transport/ClusterTransport.js';
import { FileStorage } from '../../dist/raft/storage/FileStorage.js';
import { MemoryStorage } from '../../dist/raft/storage/MemoryStorage.js';
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
  const useMem = process.env.BENCH_STORAGE === 'memory';
  const storage = useMem ? new MemoryStorage() : new FileStorage(dir);
  const node = new RaftNode(
    { nodeId: id, peers, electionTimeoutMin: 1000, electionTimeoutMax: 2000 },
    new NoopSM(),
    transport,
    storage
  );
  await node.start();
  return { node, transport, storage, dir };
}

async function main() {
  const bus = new InMemoryBus();
  const A = await makeNode(bus, 'A', ['B', 'C']);
  const B = await makeNode(bus, 'B', ['A', 'C']);
  const C = await makeNode(bus, 'C', ['A', 'B']);

  await B.transport.sendRPC('A', {
    type: 'AppendEntries',
    term: 1,
    leaderId: 'B',
    prevLogIndex: 0,
    prevLogTerm: 0,
    entries: [],
    leaderCommit: 0,
  });
  await B.transport.sendRPC('C', {
    type: 'AppendEntries',
    term: 1,
    leaderId: 'B',
    prevLogIndex: 0,
    prevLogTerm: 0,
    entries: [],
    leaderCommit: 0,
  });

  const total = 2000;
  const t0 = performance.now();
  for (let i = 1; i <= total; i++) {
    const entry = { index: i, term: 1, command: { n: i } };
  await Promise.all([
      B.transport.sendRPC('A', {
        type: 'AppendEntries',
        term: 1,
        leaderId: 'B',
        prevLogIndex: i - 1,
        prevLogTerm: i > 1 ? 1 : 0,
        entries: [entry],
        leaderCommit: i,
      }),
      B.transport.sendRPC('C', {
        type: 'AppendEntries',
        term: 1,
        leaderId: 'B',
        prevLogIndex: i - 1,
        prevLogTerm: i > 1 ? 1 : 0,
        entries: [entry],
        leaderCommit: i,
      }),
    ]);
  }
  const t1 = performance.now();
  const durMs = t1 - t0;
  const opsPerSec = (total / durMs) * 1000;
  console.log(
    `Replicated ${total} entries in ${durMs.toFixed(1)}ms -> ${opsPerSec.toFixed(1)} ops/sec`
  );

  await A.node.stop();
  await B.node.stop();
  await C.node.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

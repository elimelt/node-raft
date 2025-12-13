#!/usr/bin/env node
import os from 'node:os';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Session } from 'node:inspector';

import { InMemoryBus } from '../dist/raft/transport/ClusterTransport.js';
import { ClusterTransport } from '../dist/raft/transport/ClusterTransport.js';
import { FileStorage } from '../dist/raft/storage/FileStorage.js';
import { MemoryStorage } from '../dist/raft/storage/MemoryStorage.js';
import { RaftNode } from '../dist/raft/core/RaftNode.js';

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
  const p = `${os.tmpdir()}/${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return p;
}

async function makeNode(bus, id, peers) {
  const transport = new ClusterTransport(bus);
  const storage = new FileStorage(tmpDir(`raft-${id}`));
  const storageType = process.env.PROFILE_STORAGE;
  const storageSelected = storageType === 'memory' ? new MemoryStorage() : storage;
  const node = new RaftNode(
    { nodeId: id, peers, electionTimeoutMin: 1e9, electionTimeoutMax: 1e9 },
    new NoopSM(),
    transport,
    storageSelected
  );
  await node.start();
  return { node, transport, storage: storageSelected, id };
}

async function main() {
  const entries = parseInt(process.env.PROFILE_ENTRIES ?? '2000', 10);
  const nodesCount = Math.max(3, parseInt(process.env.PROFILE_NODES ?? '3', 10));
  const doCpuProf = process.env.PROFILE_CPUPROF === '1';
  const profDir = process.env.PROFILE_CPUPROF_DIR ?? 'profiles';
  const profName = process.env.PROFILE_CPUPROF_NAME ?? `raft-profile-${Date.now()}`;

  const cpus = os.cpus()?.length ?? 1;
  const nodeVersion = process.version;
  const platform = `${process.platform} ${process.arch}`;

  const bus = new InMemoryBus();
  const ids = Array.from({ length: nodesCount }, (_, i) => String.fromCharCode(65 + i));
  const nodes = [];
  for (const id of ids) {
    const peers = ids.filter((x) => x !== id);
    nodes.push(await makeNode(bus, id, peers));
  }

  const leaderId = ids[0];
  const leader = nodes.find((n) => n.id === leaderId);
  const followers = nodes.filter((n) => n.id !== leaderId).map((n) => n.id);

  await Promise.all(
    followers.map((fid) =>
      leader.transport.sendRPC(fid, {
        type: 'AppendEntries',
        term: 1,
        leaderId,
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      })
    )
  );

  const loopHist = monitorEventLoopDelay({ resolution: 10 });
  let session = null;
  if (doCpuProf) {
    await fs.mkdir(profDir, { recursive: true });
    session = new Session();
    session.connect();
    await new Promise((resolve, reject) =>
      session.post('Profiler.enable', {}, (err) => (err ? reject(err) : resolve()))
    );
    await new Promise((resolve, reject) =>
      session.post('Profiler.start', {}, (err) => (err ? reject(err) : resolve()))
    );
  }
  loopHist.enable();
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  process.memoryUsage();

  for (let i = 1; i <= entries; i++) {
    const entry = { index: i, term: 1, command: { n: i } };
    await Promise.all(
      followers.map((fid) =>
        leader.transport.sendRPC(fid, {
          type: 'AppendEntries',
          term: 1,
          leaderId,
          prevLogIndex: i - 1,
          prevLogTerm: i > 1 ? 1 : 0,
          entries: [entry],
          leaderCommit: i,
        })
      )
    );
  }

  const cpu1 = process.cpuUsage(cpu0);
  const mem1 = process.memoryUsage();
  const t1 = performance.now();
  loopHist.disable();

  const durMs = t1 - t0;
  const opsPerSec = (entries / durMs) * 1000;
  const rssMB = mem1.rss / (1024 * 1024);
  const heapMB = mem1.heapUsed / (1024 * 1024);
  const cpuUserMs = cpu1.user / 1000;
  const cpuSystemMs = cpu1.system / 1000;

  function nsToMs(ns) {
    return ns / 1e6;
  }
  const elMean = nsToMs(loopHist.mean);
  const elP95 = nsToMs(loopHist.percentile(95));
  const elP99 = nsToMs(loopHist.percentile(99));

  console.log('Profile Summary');
  console.log(`- Node: ${nodeVersion} (${platform}), cpus=${cpus}`);
  console.log(`- Cluster: nodes=${nodesCount}, leader=${leaderId}, followers=${followers.length}`);
  console.log(`- Workload: entries=${entries}`);
  console.log(`- Duration: ${durMs.toFixed(1)} ms  (${opsPerSec.toFixed(1)} ops/sec)`);
  console.log(`- CPU: user=${cpuUserMs.toFixed(1)} ms, system=${cpuSystemMs.toFixed(1)} ms`);
  console.log(`- Memory: rss=${rssMB.toFixed(1)} MB, heapUsed=${heapMB.toFixed(1)} MB`);
  console.log(
    `- EventLoop delay: mean=${elMean.toFixed(2)} ms, p95=${elP95.toFixed(2)} ms, p99=${elP99.toFixed(2)} ms`
  );
  if (session) {
    const result = await new Promise((resolve, reject) =>
      session.post('Profiler.stop', {}, (err, params) => (err ? reject(err) : resolve(params)))
    );
    const outPath = path.join(profDir, `${profName}.cpuprofile`);
    await fs.writeFile(outPath, JSON.stringify(result.profile));
    console.log(`CPU profile saved to: ${outPath}`);
  }

  await Promise.all(nodes.map((n) => n.node.stop()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

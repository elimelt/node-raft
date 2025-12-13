import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

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

class RNG {
  constructor(seed = 123456789) {
    this.state = seed >>> 0;
  }
  next() {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state;
  }
  float() {
    return this.next() / 0xffffffff;
  }
  int(n) {
    return this.next() % n;
  }
  bool(p = 0.5) {
    return this.float() < p;
  }
}

class SimNetwork {
  constructor(rng) {
    this.rng = rng;
    this.nodes = new Map();
    this.queue = [];
    this.partitions = new Set();
    this.voteTally = new Map();
  }
  key(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }
  isPartitioned(a, b) {
    return this.partitions.has(this.key(a, b));
  }
  setPartition(a, b, blocked) {
    const k = this.key(a, b);
    if (blocked) this.partitions.add(k);
    else this.partitions.delete(k);
  }
  register(nodeId, handler) {
    this.nodes.set(nodeId, { handler });
  }
  unregister(nodeId) {
    this.nodes.delete(nodeId);
  }
  enqueue(from, to, message) {
    let resolve, reject;
    const p = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    p.catch(() => {});
    const id = `${Date.now()}-${Math.random()}`;
    this.queue.push({ id, from, to, message, resolve, reject });
    return { id, promise: p };
  }
  size() {
    return this.queue.length;
  }
  async step() {
    if (this.queue.length === 0) return false;
    const idx = this.rng.int(this.queue.length);
    const ev = this.queue.splice(idx, 1)[0];
    if (this.rng.bool(0.05)) {
      ev.reject?.(new Error('dropped'));
      return true;
    }
    if (this.rng.bool(0.05)) {
      this.queue.push(ev);
    }
    if (this.rng.bool(0.1)) {
      this.queue.push(ev);
      return true;
    }
    if (this.isPartitioned(ev.from, ev.to)) {
      ev.reject?.(new Error('partitioned'));
      return true;
    }
    const node = this.nodes.get(ev.to);
    if (!node) {
      ev.reject?.(new Error('unknown dest'));
      return true;
    }
    const response = await node.handler({ ...ev.message, from: ev.from });
    if (ev.message.type === 'RequestVote') {
      const term = ev.message.term;
      if (response.voteGranted) {
        if (!this.voteTally.has(term)) this.voteTally.set(term, new Map());
        const m = this.voteTally.get(term);
        const set = m.get(ev.message.candidateId) ?? new Set();
        set.add(ev.to);
        m.set(ev.message.candidateId, set);
      }
    }
    ev.resolve?.(response);
    return true;
  }
}

class SimTransport {
  constructor(network) {
    this.network = network;
    this.nodeId = null;
  }
  async initialize(nodeId, _peers) {
    this.nodeId = nodeId;
  }
  onRPC(handler) {
    this.network.register(this.nodeId, handler);
  }
  async sendRPC(peerId, message) {
    const { promise } = this.network.enqueue(this.nodeId, peerId, message);
    return promise;
  }
  async shutdown() {
    this.network.unregister(this.nodeId);
    this.nodeId = null;
  }
}

async function makeNode(net, id, peers) {
  const transport = new SimTransport(net);
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
  return { node, transport, storage, id };
}

async function cluster(net, ids) {
  const nodes = [];
  for (const id of ids) {
    const peers = ids.filter((x) => x !== id);
    nodes.push(await makeNode(net, id, peers));
  }
  return nodes;
}

async function shutdown(nodes) {
  await Promise.all(nodes.map((n) => n.node.stop()));
}

async function checkLogMatching(nodes) {
  const logs = [];
  for (const n of nodes) {
    logs.push({ id: n.id, entries: await n.storage.getEntries(1, 10000) });
  }
  for (let i = 0; i < logs.length; i++) {
    for (let j = i + 1; j < logs.length; j++) {
      const a = logs[i],
        b = logs[j];
      const maxIndex = Math.max(
        a.entries.length ? a.entries[a.entries.length - 1].index : 0,
        b.entries.length ? b.entries[b.entries.length - 1].index : 0
      );
      for (let idx = 1; idx <= maxIndex; idx++) {
        const ea = a.entries.find((e) => e.index === idx);
        const eb = b.entries.find((e) => e.index === idx);
        if (ea && eb && ea.term === eb.term) {
          for (let k = 1; k <= idx; k++) {
            const pa = a.entries.find((e) => e.index === k);
            const pb = b.entries.find((e) => e.index === k);
            assert.deepEqual(pa, pb, `log mismatch up to ${idx} between ${a.id} and ${b.id}`);
          }
        }
      }
    }
  }
}

async function checkStateMachineSafety(nodes) {
  const states = nodes.map((n) => n.node.getState());
  const committed = Math.max(...states.map((s) => s.commitIndex));
  if (committed <= 0) return;
  const snapshots = [];
  for (const n of nodes) {
    snapshots.push({
      id: n.id,
      entries: await n.storage.getEntries(1, committed),
      ci: n.node.getState().commitIndex,
    });
  }
  for (let idx = 1; idx <= committed; idx++) {
    let expected = null;
    for (const s of snapshots) {
      if (s.ci >= idx) {
        const e = s.entries.find((x) => x.index === idx);
        if (!expected) expected = e;
        else assert.deepEqual(e, expected, `state machine safety violated at ${idx}`);
      }
    }
  }
}

function majority(n) {
  return Math.floor(n / 2) + 1;
}

test('Correctness: random simulations preserve core invariants', async () => {
  const seeds = [1, 2, 3, 4, 5];
  for (const seed of seeds) {
    const rng = new RNG(seed);
    const net = new SimNetwork(rng);
    const nodes = await cluster(net, ['A', 'B', 'C', 'D', 'E']);
    const N = nodes.length;

    const terms = 3;
    for (let t = 1; t <= terms; t++) {
      if (rng.bool(0.3)) net.setPartition('A', 'B', true);
      if (rng.bool(0.3)) net.setPartition('C', 'D', true);
      if (rng.bool(0.2)) net.setPartition('B', 'C', true);

      const candidates = nodes.filter(() => rng.bool(0.5)).map((n) => n.id);
      if (candidates.length === 0) candidates.push(nodes[rng.int(N)].id);
      for (const cid of candidates) {
        for (const n of nodes) {
          if (n.id === cid) continue;
          net.enqueue(cid, n.id, {
            type: 'RequestVote',
            term: t,
            candidateId: cid,
            lastLogIndex: 0,
            lastLogTerm: 0,
          });
        }
      }

      let steps = 0;
      while (steps < 200 && (await net.step())) {
        steps++;
      }

      const tally = net.voteTally.get(t) ?? new Map();
      const winners = Array.from(tally.entries()).filter(([, set]) => set.size >= majority(N));
      assert.ok(winners.length <= 1, `election safety violated in term ${t}`);

      if (winners.length === 1) {
        const leader = winners[0][0];
        if (rng.bool(0.5)) net.partitions.clear();
        const ops = rng.int(5) + 1;
        for (let i = 1; i <= ops; i++) {
          for (const n of nodes) {
            if (n.id === leader) continue;
            net.enqueue(leader, n.id, {
              type: 'AppendEntries',
              term: t,
              leaderId: leader,
              prevLogIndex: i - 1,
              prevLogTerm: i > 1 ? t : 0,
              entries: [{ index: i, term: t, command: { op: 'set', key: `k${i}`, value: i } }],
              leaderCommit: i,
            });
          }
          let k = 0;
          while (k < 100 && (await net.step())) {
            k++;
          }
        }
      }

      await checkLogMatching(nodes);
      await checkStateMachineSafety(nodes);

      if (rng.bool(0.5)) net.partitions.clear();
    }

    await shutdown(nodes);
  }
});

test('Correctness: small exhaustive delivery order for 3 nodes, 1 term', async () => {
  const rng = new RNG(42);
  const net = new SimNetwork(rng);
  const nodes = await cluster(net, ['A', 'B', 'C']);
  const N = nodes.length;
  const t = 1;
  const cid = 'A';
  for (const n of nodes) {
    if (n.id !== cid)
      net.enqueue(cid, n.id, {
        type: 'RequestVote',
        term: t,
        candidateId: cid,
        lastLogIndex: 0,
        lastLogTerm: 0,
      });
  }

  async function dfs(depth) {
    if (depth === 6 || net.size() === 0) {
      await checkLogMatching(nodes);
      await checkStateMachineSafety(nodes);
      const tally = net.voteTally.get(t) ?? new Map();
      const winners = Array.from(tally.entries()).filter(([, set]) => set.size >= majority(N));
      assert.ok(winners.length <= 1, 'election safety violated');
      return;
    }
    const snapshot = net.queue.slice();
    for (let i = 0; i < snapshot.length; i++) {
      const ev = snapshot[i];
      const idx = net.queue.findIndex((e) => e.id === ev.id);
      if (idx === -1) continue;
      const [cur] = net.queue.splice(idx, 1);
      const node = net.nodes.get(cur.to);
      if (node) {
        const resp = await node.handler({ ...cur.message, from: cur.from });
        if (cur.message.type === 'RequestVote' && resp.voteGranted) {
          if (!net.voteTally.has(t)) net.voteTally.set(t, new Map());
          const m = net.voteTally.get(t);
          const set = m.get(cur.message.candidateId) ?? new Set();
          set.add(cur.to);
          m.set(cur.message.candidateId, set);
        }
        cur.resolve?.(resp);
      }
      await dfs(depth + 1);
    }
  }
  await dfs(0);
  await shutdown(nodes);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { RaftNode } from '../../dist/raft/core/RaftNode.js';

class InMemoryStorage {
  constructor() {
    this.state = { currentTerm: 0, votedFor: null, log: [] };
    this.snapshotObj = undefined;
  }
  async saveState(state) {
    this.state.currentTerm = state.currentTerm;
    this.state.votedFor = state.votedFor;
  }
  async loadState() {
    return { ...this.state, log: [...this.state.log] };
  }
  async appendEntries(entries) {
    for (const e of entries) {
      const idx = this.state.log.findIndex((x) => x.index === e.index);
      if (idx >= 0) this.state.log.splice(idx);
      this.state.log.push({ ...e });
    }
    this.state.log.sort((a, b) => a.index - b.index);
  }
  async getEntry(index) {
    return this.state.log.find((e) => e.index === index);
  }
  async getEntries(startIndex, endIndex) {
    return this.state.log
      .filter((e) => e.index >= startIndex && e.index <= endIndex)
      .map((e) => ({ ...e }));
  }
  async deleteEntriesFrom(index) {
    this.state.log = this.state.log.filter((e) => e.index < index);
  }
  async getLastIndex() {
    return this.state.log.length ? Math.max(...this.state.log.map((e) => e.index)) : 0;
  }
  async saveSnapshot(snapshot) {
    this.snapshotObj = snapshot;
    this.state.log = this.state.log.filter((e) => e.index > snapshot.lastIncludedIndex);
  }
  async loadSnapshot() {
    return this.snapshotObj;
  }
}

class SimTransport {
  static registry = new Map();
  constructor() {
    this.nodeId = null;
  }
  async initialize(nodeId, _peers) {
    this.nodeId = nodeId;
  }
  onRPC(handler) {
    SimTransport.registry.set(this.nodeId, handler);
  }
  async sendRPC(peerId, message) {
    const h = SimTransport.registry.get(peerId);
    if (!h) throw new Error(`Unknown peer ${peerId}`);
    return h({ ...message, from: this.nodeId });
  }
  async shutdown() {
    SimTransport.registry.delete(this.nodeId);
    this.nodeId = null;
  }
}

function mkIds(n) {
  return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
}

async function createCluster(n) {
  const ids = mkIds(n);
  const nodes = [];
  for (const id of ids) {
    const storage = new InMemoryStorage();
    const transport = new SimTransport();
    const sm = {
      apply: async (e) => e,
      snapshot: async () => new Uint8Array(),
      restore: async () => {},
    };
    const node = new RaftNode(
      {
        nodeId: id,
        peers: ids.filter((x) => x !== id),
        electionTimeoutMin: 1e9,
        electionTimeoutMax: 1e9,
      },
      sm,
      transport,
      storage
    );
    await node.start();
    nodes.push({ id, node, storage, transport });
  }
  return nodes;
}

async function destroyCluster(nodes) {
  await Promise.all(nodes.map((n) => n.node.stop()));
}


function majority(n) {
  return Math.floor(n / 2) + 1;
}

async function deliver(nodeMap, msg) {
  const h = SimTransport.registry.get(msg.to);
  if (!h) throw new Error('handler missing');
  return h({ ...msg.message, from: msg.from });
}


function computeWinners(nodes, term) {
  const votes = new Map();
  for (const n of nodes) {
    if (n.storage.state.currentTerm === term && n.storage.state.votedFor) {
      const cid = n.storage.state.votedFor;
      votes.set(cid, (votes.get(cid) ?? 0) + 1);
    }
  }
  const wins = Array.from(votes.entries())
    .filter(([, c]) => c >= majority(nodes.length))
    .map(([cid]) => cid);
  return wins;
}

function genVoteMessages(ids, candidates, term) {
  const msgs = [];
  for (const cid of candidates) {
    for (const to of ids) {
      if (to === cid) continue;
      msgs.push({
        from: cid,
        to,
        message: { type: 'RequestVote', term, candidateId: cid, lastLogIndex: 0, lastLogTerm: 0 },
      });
    }
  }
  return msgs;
}

function permuteDeliveries(len, limit) {
  const results = [];
  function dfs(prefix, remaining) {
    if (prefix.length === len) {
      results.push(prefix.slice());
      return;
    }
    const choices = remaining.slice(0, limit ?? remaining.length);
    for (let i = 0; i < choices.length; i++) {
      const idx = choices[i];
      const newRemaining = remaining.filter((x) => x !== idx);
      dfs(prefix.concat(idx), newRemaining);
      if (results.length >= 100000) return;
    }
  }
  dfs([], [...Array(len).keys()]);
  return results;
}

async function replicateAll(nodes, leaderId, entries, term, branchLimit) {
  const followers = nodes.map((n) => n.id).filter((id) => id !== leaderId);
  const msgs = [];
  for (let i = 1; i <= entries; i++) {
    for (const f of followers) {
      msgs.push({
        from: leaderId,
        to: f,
        message: {
          type: 'AppendEntries',
          term,
          leaderId,
          prevLogIndex: i - 1,
          prevLogTerm: i > 1 ? term : 0,
          entries: [{ index: i, term, command: { i } }],
          leaderCommit: 0,
        },
      });
    }
  }
  const orders = permuteDeliveries(msgs.length, branchLimit);
  for (const order of orders) {
    const backups = nodes.map((n) => ({
      id: n.id,
      state: JSON.parse(JSON.stringify(n.storage.state)),
      commit: n.node.getState().commitIndex,
    }));
    const ack = new Map();
    for (const step of order) {
      const m = msgs[step];
      const committed = [...ack.entries()]
        .filter(([_idx, set]) => set.size + 1 >= majority(nodes.length))
        .map(([idx]) => idx)
        .reduce((a, b) => Math.max(a, b), 0);
      m.message.leaderCommit = committed;
      const resp = await deliver(nodes, m);
      if (resp && resp.success) {
        const set = ack.get(m.message.entries[0].index) ?? new Set();
        set.add(m.to);
        ack.set(m.message.entries[0].index, set);
      }
    }
    await assertLogMatching(nodes);
    await assertStateMachineSafety(nodes);
    for (const b of backups) {
      const node = nodes.find((n) => n.id === b.id);
      node.storage.state = JSON.parse(JSON.stringify(b.state));
      node.node['commitIndex'] = b.commit;
    }
  }
}

async function assertLogMatching(nodes) {
  const logs = nodes.map((n) => ({ id: n.id, log: n.storage.state.log.map((e) => ({ ...e })) }));
  for (let i = 0; i < logs.length; i++) {
    for (let j = i + 1; j < logs.length; j++) {
      const a = logs[i],
        b = logs[j];
      const maxIndex = Math.max(
        a.log.length ? a.log[a.log.length - 1].index : 0,
        b.log.length ? b.log[b.log.length - 1].index : 0
      );
      for (let idx = 1; idx <= maxIndex; idx++) {
        const ea = a.log.find((e) => e.index === idx);
        const eb = b.log.find((e) => e.index === idx);
        if (ea && eb && ea.term === eb.term) {
          for (let k = 1; k <= idx; k++) {
            const pa = a.log.find((e) => e.index === k);
            const pb = b.log.find((e) => e.index === k);
            assert.deepEqual(pa, pb);
          }
        }
      }
    }
  }
}

async function assertStateMachineSafety(nodes) {
  const committed = Math.max(...nodes.map((n) => n.node.getState().commitIndex));
  if (committed <= 0) return;
  for (let idx = 1; idx <= committed; idx++) {
    let ref = null;
    for (const n of nodes) {
      if (n.node.getState().commitIndex >= idx) {
        const e = n.storage.state.log.find((x) => x.index === idx);
        if (!ref) ref = e;
        else assert.deepEqual(e, ref);
      }
    }
  }
}

const MC_ENABLED = process.env.MC_ENABLE === '1';
const MC_TIMEOUT_MS = parseInt(process.env.MC_TIMEOUT_MS ?? '5000', 10);
const MC_MAX_PATHS = parseInt(process.env.MC_MAX_PATHS ?? '2000', 10);

const run = MC_ENABLED ? test : test.skip;

run('Model checker: BFS over vote delivery orders and replication interleavings', async () => {
    const abort = new AbortController();
  const to = setTimeout(() => abort.abort(), MC_TIMEOUT_MS);
  const N = parseInt(process.env.MC_NODES ?? '3', 10);
  const C = Math.min(parseInt(process.env.MC_CANDIDATES ?? '2', 10), N);
  const E = parseInt(process.env.MC_ENTRIES ?? '2', 10);
  const BR = parseInt(process.env.MC_BRANCH_LIMIT ?? '6', 10);

  let nodes = [];
  try {
    nodes = await createCluster(N);
    const ids = nodes.map((n) => n.id);
    const candidates = ids.slice(0, C);
    const term = 1;
    const voteMsgs = genVoteMessages(ids, candidates, term);

    const voteOrders = permuteDeliveries(voteMsgs.length, BR);
    let processed = 0;
    for (const order of voteOrders) {
      if (abort.signal.aborted) break;
      if (processed++ >= MC_MAX_PATHS) break;
      // backup state
      const backups = nodes.map((n) => ({
        id: n.id,
        state: JSON.parse(JSON.stringify(n.storage.state)),
        commit: n.node.getState().commitIndex,
      }));
      // deliver in this order
      for (const step of order) {
        await deliver(nodes, voteMsgs[step]);
      }
            const winners = computeWinners(nodes, term);
      assert.ok(winners.length <= 1, `Election safety violated: ${winners}`);
      if (winners.length === 1) {
        const leader = winners[0];
        await replicateAll(nodes, leader, E, term, BR);
      }
            for (const b of backups) {
        const node = nodes.find((n) => n.id === b.id);
        node.storage.state = JSON.parse(JSON.stringify(b.state));
        node.node['commitIndex'] = b.commit;
      }
    }
  } finally {
    clearTimeout(to);
    if (nodes.length) await destroyCluster(nodes);
  }
});

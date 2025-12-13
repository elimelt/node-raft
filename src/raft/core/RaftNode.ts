import { defaultConfig, type RaftConfig } from '../config/RaftConfig.js';
import { ElectionTimer } from '../election/ElectionTimer.js';
import type { Storage } from '../storage/Storage.js';
import type { Transport } from '../transport/Transport.js';
import type { RPCMessage, RPCResponse } from '../transport/MessageTypes.js';
import { NodeState } from './VolatileState.js';
import type { LogEntry } from './LogEntry.js';
import type { PersistentState } from './PersistentState.js';

type StateMachine = {
  apply(entry: LogEntry): Promise<any>;
  snapshot(): Promise<Uint8Array>;
  restore(data: Uint8Array): Promise<void>;
};

type RaftNodeConfig = Partial<RaftConfig> & { nodeId: string; peers: string[] };

export class RaftNode {
  private cfg: RaftNodeConfig;
  private transport: Transport;
  private storage: Storage;

  private currentTerm = 0;
  private votedFor: string | null = null;
  private commitIndex = 0;
  private lastApplied = 0;
  private currentState: NodeState = NodeState.FOLLOWER;
  private leaderId: string | null = null;
  private electionTimer: ElectionTimer;

  constructor(
    config: RaftNodeConfig,
    _stateMachine: StateMachine,
    transport: Transport,
    storage: Storage
  ) {
    this.cfg = { ...defaultConfig, ...config } as RaftNodeConfig;
    this.transport = transport;
    this.storage = storage;
    const timerCfg: { electionTimeoutMin?: number; electionTimeoutMax?: number } = {};
    if (this.cfg.electionTimeoutMin !== undefined)
      timerCfg.electionTimeoutMin = this.cfg.electionTimeoutMin;
    if (this.cfg.electionTimeoutMax !== undefined)
      timerCfg.electionTimeoutMax = this.cfg.electionTimeoutMax;
    this.electionTimer = new ElectionTimer(timerCfg);
  }

  async start(): Promise<void> {
    await this.transport.initialize(this.cfg.nodeId, this.cfg.peers);
    const ps = await this.storage.loadState();
    this.currentTerm = ps.currentTerm;
    this.votedFor = ps.votedFor;
    this.currentState = NodeState.FOLLOWER;

    this.transport.onRPC(async (msg: RPCMessage & { from?: string }): Promise<RPCResponse> => {
      if ('term' in msg && msg.term > this.currentTerm) {
        this.currentTerm = msg.term;
        this.votedFor = null;
        this.currentState = NodeState.FOLLOWER;
        await this.persist();
      }
      switch (msg.type) {
        case 'RequestVote':
          return this.onRequestVote(msg, msg.from ?? '');
        case 'AppendEntries':
          return this.onAppendEntries(msg, msg.from ?? '');
        case 'InstallSnapshot':
          await this.storage.saveSnapshot({
            lastIncludedIndex: msg.lastIncludedIndex,
            lastIncludedTerm: msg.lastIncludedTerm,
            data: msg.data,
            timestamp: Date.now(),
          } as any);
          this.resetElectionTimer();
          return { term: this.currentTerm };
      }
    });

    this.resetElectionTimer();
  }

  async stop(): Promise<void> {
    this.electionTimer.stop();
    await this.transport.shutdown();
  }

  private resetElectionTimer() {
    this.electionTimer.onTimeout(() => {});
    this.electionTimer.reset();
  }

  private async persist() {
    const log = (await this.storage.loadState()).log;
    const state: PersistentState = { currentTerm: this.currentTerm, votedFor: this.votedFor, log };
    await this.storage.saveState(state);
  }

  private async lastLogIndexTerm(): Promise<{ index: number; term: number }> {
    const lastIndex = await this.storage.getLastIndex();
    if (lastIndex === 0) return { index: 0, term: 0 };
    const entry = await this.storage.getEntry(lastIndex);
    return { index: lastIndex, term: entry?.term ?? 0 };
  }

  private async onRequestVote(
    msg: Extract<RPCMessage, { type: 'RequestVote' }>,
    _from: string
  ): Promise<RPCResponse> {
    const { term, candidateId, lastLogIndex, lastLogTerm } = msg;
    if (term < this.currentTerm) {
      return { term: this.currentTerm, voteGranted: false };
    }
    const { index: myLastIdx, term: myLastTerm } = await this.lastLogIndexTerm();

    const upToDate =
      lastLogTerm > myLastTerm || (lastLogTerm === myLastTerm && lastLogIndex >= myLastIdx);
    if ((this.votedFor === null || this.votedFor === candidateId) && upToDate) {
      this.votedFor = candidateId;
      this.currentTerm = term;
      await this.persist();
      this.resetElectionTimer();
      return { term: this.currentTerm, voteGranted: true };
    } else {
      return { term: this.currentTerm, voteGranted: false };
    }
  }

  private async onAppendEntries(
    msg: Extract<RPCMessage, { type: 'AppendEntries' }>,
    _from: string
  ): Promise<RPCResponse> {
    const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = msg;
    if (term < this.currentTerm) {
      return { term: this.currentTerm, success: false };
    }
    this.currentState = NodeState.FOLLOWER;
    this.leaderId = leaderId;
    this.currentTerm = term;

    if (prevLogIndex > 0) {
      const prev = await this.storage.getEntry(prevLogIndex);
      if (!prev || prev.term !== prevLogTerm) {
        this.resetElectionTimer();
        return { term: this.currentTerm, success: false };
      }
    }

    if (entries.length > 0) {
      const start = entries[0]!.index;
      const end = entries[entries.length - 1]!.index;
      const existingRange = await this.storage.getEntries(start, end);
      let conflictIndex: number | null = null;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        const ex = existingRange.find((x) => x.index === e.index);
        if (ex && ex.term !== e.term) { conflictIndex = e.index; break; }
      }
      if (conflictIndex !== null) {
        await this.storage.deleteEntriesFrom(conflictIndex);
      }
      const toAppend: LogEntry[] = [];
      const base = conflictIndex !== null
        ? existingRange.filter((x) => x.index < conflictIndex)
        : existingRange;
      for (const e of entries) {
        const ex = base.find((x) => x.index === e.index);
        if (!ex) toAppend.push(e);
      }
      if (toAppend.length > 0) {
        await this.storage.appendEntries(toAppend);
      }
    }

    const lastNewIndex = entries.length > 0 ? entries[entries.length - 1]!.index : prevLogIndex;
    if (leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(leaderCommit, lastNewIndex);
    }

    this.resetElectionTimer();
    await this.persist();
    return { term: this.currentTerm, success: true };
  }

  async submitCommand(_command: any): Promise<any> {
    if (this.currentState !== NodeState.LEADER) {
      throw new Error('Not the leader');
    }
  }

  getLeader() {
    return { nodeId: this.leaderId, term: this.currentTerm };
  }

  getState() {
    return {
      nodeId: this.cfg.nodeId,
      state: this.currentState,
      term: this.currentTerm,
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
    };
  }
}

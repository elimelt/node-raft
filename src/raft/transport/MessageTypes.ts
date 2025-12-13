export type LogEntry = {
  term: number;
  command: any;
  index: number;
};

export type RequestVote = {
  type: 'RequestVote';
  term: number;
  candidateId: string;
  lastLogIndex: number;
  lastLogTerm: number;
};

export type RequestVoteResponse = {
  term: number;
  voteGranted: boolean;
};

export type AppendEntries = {
  type: 'AppendEntries';
  term: number;
  leaderId: string;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: LogEntry[];
  leaderCommit: number;
};

export type AppendEntriesResponse = {
  term: number;
  success: boolean;
  conflictTerm?: number;
  conflictIndex?: number;
};

export type InstallSnapshot = {
  type: 'InstallSnapshot';
  term: number;
  leaderId: string;
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  offset: number;
  data: Uint8Array;
  done: boolean;
};

export type InstallSnapshotResponse = {
  term: number;
};

export type RPCMessage = RequestVote | AppendEntries | InstallSnapshot;

export type RPCResponse = RequestVoteResponse | AppendEntriesResponse | InstallSnapshotResponse;

export function isRequestVote(x: any): x is RequestVote {
  return (
    x &&
    x.type === 'RequestVote' &&
    typeof x.term === 'number' &&
    typeof x.candidateId === 'string' &&
    typeof x.lastLogIndex === 'number' &&
    typeof x.lastLogTerm === 'number'
  );
}

export function isAppendEntries(x: any): x is AppendEntries {
  return (
    x &&
    x.type === 'AppendEntries' &&
    typeof x.term === 'number' &&
    typeof x.leaderId === 'string' &&
    typeof x.prevLogIndex === 'number' &&
    typeof x.prevLogTerm === 'number' &&
    Array.isArray(x.entries) &&
    typeof x.leaderCommit === 'number'
  );
}

export function isInstallSnapshot(x: any): x is InstallSnapshot {
  return (
    x &&
    x.type === 'InstallSnapshot' &&
    typeof x.term === 'number' &&
    typeof x.leaderId === 'string' &&
    typeof x.lastIncludedIndex === 'number' &&
    typeof x.lastIncludedTerm === 'number' &&
    typeof x.offset === 'number' &&
    x.data instanceof Uint8Array &&
    typeof x.done === 'boolean'
  );
}

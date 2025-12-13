export type RaftConfig = {
  electionTimeoutMin: number;
  electionTimeoutMax: number;
  heartbeatInterval: number;
  rpcTimeout: number;
  maxEntriesPerRequest: number;
  snapshotThreshold: number;
  snapshotRetainedEntries: number;
  clientRetryAttempts: number;
  clientRetryDelay: number;
};

export const defaultConfig: RaftConfig = {
  electionTimeoutMin: 150,
  electionTimeoutMax: 300,
  heartbeatInterval: 50,
  rpcTimeout: 5000,
  maxEntriesPerRequest: 100,
  snapshotThreshold: 10000,
  snapshotRetainedEntries: 1000,
  clientRetryAttempts: 3,
  clientRetryDelay: 100,
};

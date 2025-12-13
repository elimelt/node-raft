import type { LogEntry } from './LogEntry.js';

export type PersistentState = {
  currentTerm: number;
  votedFor: string | null;
  log: LogEntry[];
};

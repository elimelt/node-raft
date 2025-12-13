import type { PersistentState } from '../core/PersistentState.js';
import type { LogEntry } from '../core/LogEntry.js';
import type { Snapshot } from './Snapshot.js';

export interface Storage {
  saveState(state: PersistentState): Promise<void>;
  loadState(): Promise<PersistentState>;

  appendEntries(entries: LogEntry[]): Promise<void>;
  getEntry(index: number): Promise<LogEntry | undefined>;
  getEntries(startIndex: number, endIndex: number): Promise<LogEntry[]>;
  deleteEntriesFrom(index: number): Promise<void>;
  getLastIndex(): Promise<number>;

  saveSnapshot(snapshot: Snapshot): Promise<void>;
  loadSnapshot(): Promise<Snapshot | undefined>;
}

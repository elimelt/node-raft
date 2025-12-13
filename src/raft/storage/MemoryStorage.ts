import type { Storage } from './Storage.js';
import type { PersistentState } from '../core/PersistentState.js';
import type { LogEntry } from '../core/LogEntry.js';
import type { Snapshot } from './Snapshot.js';

export class MemoryStorage implements Storage {
  private state: PersistentState = { currentTerm: 0, votedFor: null, log: [] };
  private snapshotObj: Snapshot | undefined;
  private indexMap: Map<number, number> = new Map();

  private rebuildIndex() {
    this.indexMap.clear();
    for (let i = 0; i < this.state.log.length; i++) {
      this.indexMap.set(this.state.log[i]!.index, i);
    }
  }

  async saveState(state: PersistentState): Promise<void> {
    this.state.currentTerm = state.currentTerm;
    this.state.votedFor = state.votedFor;
  }

  async loadState(): Promise<PersistentState> {
    return { currentTerm: this.state.currentTerm, votedFor: this.state.votedFor, log: [...this.state.log] };
  }

  async appendEntries(entries: LogEntry[]): Promise<void> {
    if (!entries.length) return;
    for (const e of entries) {
      const pos = this.indexMap.get(e.index);
      if (pos !== undefined) {
        this.state.log.splice(pos, this.state.log.length - pos, e);
      } else {
        this.state.log.push(e);
      }
    }
    this.state.log.sort((a, b) => a.index - b.index);
    this.rebuildIndex();
  }

  async getEntry(index: number): Promise<LogEntry | undefined> {
    const pos = this.indexMap.get(index);
    return pos !== undefined ? this.state.log[pos] : undefined;
  }

  async getEntries(startIndex: number, endIndex: number): Promise<LogEntry[]> {
    return this.state.log.filter((e) => e.index >= startIndex && e.index <= endIndex);
  }

  async deleteEntriesFrom(index: number): Promise<void> {
    const pos = this.indexMap.get(index);
    if (pos !== undefined) {
      this.state.log.splice(pos);
      this.rebuildIndex();
    }
  }

  async getLastIndex(): Promise<number> {
    if (!this.state.log.length) return 0;
    return this.state.log[this.state.log.length - 1]!.index;
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    this.snapshotObj = snapshot;
    this.state.log = this.state.log.filter((e) => e.index > snapshot.lastIncludedIndex);
    this.rebuildIndex();
  }

  async loadSnapshot(): Promise<Snapshot | undefined> {
    return this.snapshotObj;
  }
}


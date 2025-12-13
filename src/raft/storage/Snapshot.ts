export class Snapshot {
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  data: Uint8Array;
  timestamp: number;

  constructor(lastIncludedIndex: number, lastIncludedTerm: number, data: Uint8Array) {
    this.lastIncludedIndex = lastIncludedIndex;
    this.lastIncludedTerm = lastIncludedTerm;
    this.data = data;
    this.timestamp = Date.now();
  }
}

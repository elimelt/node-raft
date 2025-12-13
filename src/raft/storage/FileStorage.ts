import path from 'node:path';
import fs from 'node:fs/promises';
import type { Storage } from './Storage.js';
import type { PersistentState } from '../core/PersistentState.js';
import type { LogEntry } from '../core/LogEntry.js';
import type { Snapshot } from './Snapshot.js';

export class FileStorage implements Storage {
  private dir: string;
  private statePath: string;
  private logPath: string;
  private snapPath: string;
  private logCache: LogEntry[] | null = null;
  private logAOFPath: string;
  private pendingOps: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushIntervalMs = 10;
  private indexMap: Map<number, number> = new Map();

  constructor(dir: string = './raft-data') {
    this.dir = dir;
    this.statePath = path.join(dir, 'state.json');
    this.logPath = path.join(dir, 'log.json');
    this.snapPath = path.join(dir, 'snapshot.json');
    this.logAOFPath = path.join(dir, 'log.aof');
  }

  private async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async saveState(state: PersistentState): Promise<void> {
    await this.ensureDir();
    const toSave = { currentTerm: state.currentTerm, votedFor: state.votedFor };
    await fs.writeFile(this.statePath, JSON.stringify(toSave), 'utf8');
  }

  async loadState(): Promise<PersistentState> {
    await this.ensureDir();
    let currentTerm = 0;
    let votedFor: string | null = null;
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      const obj = JSON.parse(raw);
      currentTerm = obj.currentTerm ?? 0;
      votedFor = obj.votedFor ?? null;
    } catch {}
    const log = await this.readLog();
    return { currentTerm, votedFor, log };
  }

  private async readLog(): Promise<LogEntry[]> {
    await this.ensureDir();
    if (this.logCache) return this.logCache;
    try {
      const raw = await fs.readFile(this.logAOFPath, 'utf8');
      const entries: LogEntry[] = [];
      let trimPrefixUpTo = 0;
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec && rec.type === 'append' && rec.entry) {
            const e = rec.entry as LogEntry;
            const pos = entries.findIndex((x) => x.index === e.index);
            if (pos >= 0) entries.splice(pos, entries.length - pos, e);
            else entries.push(e);
          } else if (rec && rec.type === 'truncate' && typeof rec.fromIndex === 'number') {
            const from = rec.fromIndex as number;
            for (let i = entries.length - 1; i >= 0; i--) {
              if (entries[i]!.index >= from) entries.pop();
              else break;
            }
          } else if (rec && rec.type === 'trim' && typeof rec.upToIndex === 'number') {
            trimPrefixUpTo = Math.max(trimPrefixUpTo, rec.upToIndex as number);
          }
        } catch {}
      }
      this.logCache = entries
        .filter((e) => e.index > trimPrefixUpTo)
        .sort((a, b) => a.index - b.index);
      this.rebuildIndex();
      return this.logCache;
    } catch {
      try {
        const raw = await fs.readFile(this.logPath, 'utf8');
        const arr = JSON.parse(raw);
        this.logCache = Array.isArray(arr) ? (arr as LogEntry[]) : [];
      } catch {
        this.logCache = [];
      }
      this.rebuildIndex();
      return this.logCache;
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private async flush(): Promise<void> {
    if (!this.pendingOps.length) return;
    const chunk = this.pendingOps.join('');
    this.pendingOps.length = 0;
    await fs.appendFile(this.logAOFPath, chunk, 'utf8');
  }

  private rebuildIndex() {
    this.indexMap.clear();
    const arr = this.logCache ?? [];
    for (let i = 0; i < arr.length; i++) this.indexMap.set(arr[i]!.index, i);
  }

  async compactAOF(): Promise<void> {
    await this.flush();
    const entries = this.logCache ?? [];
    const lines =
      entries.map((e) => JSON.stringify({ type: 'append', entry: e })).join('\n') +
      (entries.length ? '\n' : '');
    await fs.writeFile(this.logAOFPath, lines, 'utf8');
  }

  async appendEntries(entries: LogEntry[]): Promise<void> {
    if (!entries.length) return;
    const log = await this.readLog();
    for (const e of entries) {
      const existing = log.find((le) => le.index === e.index);
      if (existing) {
        const pos = log.findIndex((le) => le.index === e.index);
        log.splice(pos, log.length - pos, e);
        this.rebuildIndex();
      } else {
        log.push(e);
        this.indexMap.set(e.index, log.length - 1);
      }
      this.pendingOps.push(JSON.stringify({ type: 'append', entry: e }) + '\n');
    }
    log.sort((a, b) => a.index - b.index);
    this.logCache = log;
    this.rebuildIndex();
    this.scheduleFlush();
  }

  async getEntry(index: number): Promise<LogEntry | undefined> {
    const log = await this.readLog();
    const pos = this.indexMap.get(index);
    return pos !== undefined ? log[pos] : undefined;
  }

  async getEntries(startIndex: number, endIndex: number): Promise<LogEntry[]> {
    const log = await this.readLog();
    return log.filter((e) => e.index >= startIndex && e.index <= endIndex);
  }

  async deleteEntriesFrom(index: number): Promise<void> {
    const log = await this.readLog();
    const trimmed = log.filter((e) => e.index < index);
    this.logCache = trimmed;
    this.rebuildIndex();
    this.pendingOps.push(JSON.stringify({ type: 'truncate', fromIndex: index }) + '\n');
    this.scheduleFlush();
  }

  async getLastIndex(): Promise<number> {
    const log = await this.readLog();
    if (!log.length) return 0;
    return Math.max(...log.map((e) => e.index));
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    await this.ensureDir();
    const obj = {
      lastIncludedIndex: snapshot.lastIncludedIndex,
      lastIncludedTerm: snapshot.lastIncludedTerm,
      data: Buffer.from(snapshot.data).toString('base64'),
      timestamp: snapshot.timestamp ?? Date.now(),
    };
    await fs.writeFile(this.snapPath, JSON.stringify(obj), 'utf8');
    const log = await this.readLog();
    const trimmed = log.filter((e) => e.index > snapshot.lastIncludedIndex);
    this.logCache = trimmed;
    this.rebuildIndex();
    this.pendingOps.push(
      JSON.stringify({ type: 'trim', upToIndex: snapshot.lastIncludedIndex }) + '\n'
    );
    this.scheduleFlush();
    // Compact AOF after snapshot to keep replay fast
    await this.compactAOF();
  }

  async loadSnapshot(): Promise<Snapshot | undefined> {
    try {
      const raw = await fs.readFile(this.snapPath, 'utf8');
      const obj = JSON.parse(raw);
      return {
        lastIncludedIndex: obj.lastIncludedIndex ?? 0,
        lastIncludedTerm: obj.lastIncludedTerm ?? 0,
        data: new Uint8Array(Buffer.from(obj.data ?? '', 'base64')),
        timestamp: obj.timestamp ?? Date.now(),
      } as Snapshot;
    } catch {
      return undefined;
    }
  }
}

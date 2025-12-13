#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

async function removeIsolateLogs(cwd) {
  const files = await fs.readdir(cwd);
  await Promise.all(
    files
      .filter((f) => f.startsWith('isolate-') && f.endsWith('.log'))
      .map((f) => fs.rm(path.join(cwd, f)).catch(() => {}))
  );
}

function runNodeProf(target, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--prof', target], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`profiled process exited with code ${code}`));
    });
  });
}

async function findIsolateLog(cwd) {
  const files = await fs.readdir(cwd);
  const logs = files.filter((f) => f.startsWith('isolate-') && f.endsWith('.log'));
  if (logs.length === 0) throw new Error('No V8 isolate log produced');
  const stats = await Promise.all(
    logs.map(async (f) => ({ f, t: (await fs.stat(path.join(cwd, f))).mtimeMs }))
  );
  stats.sort((a, b) => b.t - a.t);
  return path.join(cwd, stats[0].f);
}

function processLog(logPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--prof-process', logPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`prof-process exited with code ${code}`));
    });
  });
}

function printSummary(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('Statistical profiling result')); 
  const end = lines.findIndex((l, i) => i > start && l.trim().startsWith(' [Shared libraries]'));
  const section = start >= 0 ? lines.slice(start, end > start ? end : undefined) : lines;
  console.log('==== V8 Prof Summary ====');
  console.log(section.join('\n'));
  const js = lines.filter((l) => /\s+\d+\s+(?:\d+\.\d+)%\s+\.\w+\s+JS/.test(l));
  if (js.length) {
    console.log('\nTop JS frames:');
    console.log(js.slice(0, 20).join('\n'));
  }
}

async function main() {
  const cwd = process.cwd();
  await removeIsolateLogs(cwd);
  const env = {
    PROFILE_ENTRIES: process.env.PROFILE_ENTRIES ?? '5000',
    PROFILE_NODES: process.env.PROFILE_NODES ?? '3',
  };
  await runNodeProf(path.join('scripts', 'profile.js'), env);
  const log = await findIsolateLog(cwd);
  const processed = await processLog(log);
  printSummary(processed);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

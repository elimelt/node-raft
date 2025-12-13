#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function findLatestProfile(dir) {
  const files = await fs.readdir(dir);
  const cpus = files.filter((f) => f.endsWith('.cpuprofile'));
  if (!cpus.length) return null;
  const stats = await Promise.all(
    cpus.map(async (f) => ({ f, t: (await fs.stat(path.join(dir, f))).mtimeMs }))
  );
  stats.sort((a, b) => b.t - a.t);
  return path.join(dir, stats[0].f);
}

function runWithCpuProf(target, dir, name, env = {}) {
  return new Promise((resolve, reject) => {
    const args = [target];
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, ...env, PROFILE_CPUPROF: '1', PROFILE_CPUPROF_DIR: dir, PROFILE_CPUPROF_NAME: name },
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`profiled process exited with code ${code}`));
    });
  });
}

async function main() {
  const outDir = path.resolve('profiles');
  await ensureDir(outDir);
  const name = `raft-profile-${Date.now()}`;
  const env = {
    PROFILE_ENTRIES: process.env.PROFILE_ENTRIES ?? '5000',
    PROFILE_NODES: process.env.PROFILE_NODES ?? '3',
  };
  await runWithCpuProf(path.join('scripts', 'profile.js'), outDir, name, env);
  const latest = await findLatestProfile(outDir);
  if (!latest) {
    console.error('No .cpuprofile was produced.');
    process.exit(1);
  }
  console.log('CPU profile written:');
  console.log(latest);
  console.log('Open in Chrome DevTools (Performance tab) or VS Code to view flamecharts.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

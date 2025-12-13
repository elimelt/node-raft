import test from 'node:test';
import assert from 'node:assert/strict';
import { ElectionTimer } from './ElectionTimer.js';

test('ElectionTimer triggers callback within configured range', async () => {
  const timer = new ElectionTimer({ electionTimeoutMin: 10, electionTimeoutMax: 20 });
  let fired = false;
  timer.onTimeout(() => {
    fired = true;
  });
  const start = Date.now();
  timer.reset();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const elapsed = Date.now() - start;
  assert.equal(fired, true);
  assert.ok(elapsed >= 10, `elapsed ${elapsed} should be >= 10`);
  assert.ok(elapsed <= 100, `elapsed ${elapsed} should be <= 100`);
  timer.stop();
});

test('ElectionTimer stop prevents firing', async () => {
  const timer = new ElectionTimer({ electionTimeoutMin: 10, electionTimeoutMax: 10 });
  let fired = false;
  timer.onTimeout(() => {
    fired = true;
  });
  timer.reset();
  timer.stop();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fired, false);
});

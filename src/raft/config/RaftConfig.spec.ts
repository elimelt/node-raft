import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from './RaftConfig.js';

test('defaultConfig has sane timing parameters', () => {
  assert.ok(defaultConfig.electionTimeoutMin >= 50);
  assert.ok(defaultConfig.electionTimeoutMax > defaultConfig.electionTimeoutMin);
  assert.ok(defaultConfig.heartbeatInterval < defaultConfig.electionTimeoutMin);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ClusterTransport, InMemoryBus } from './ClusterTransport.js';

test('ClusterTransport RPC round trip', async () => {
  const bus = new InMemoryBus();
  const a = new ClusterTransport(bus);
  const b = new ClusterTransport(bus);
  await a.initialize('A', ['B']);
  await b.initialize('B', ['A']);
  b.onRPC(async (_msg) => {
    return { term: 1, voteGranted: true } as any;
  });
  const resp = await a.sendRPC('B', {
    type: 'RequestVote',
    term: 1,
    candidateId: 'A',
    lastLogIndex: 0,
    lastLogTerm: 0,
  });
  assert.deepEqual(resp, { term: 1, voteGranted: true });
  await a.shutdown();
  await b.shutdown();
});

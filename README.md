# node-raft

A Raft consensus algorithm implementation for Node.js.

## Installation

```bash
npm install node-raft
```

## Usage

```javascript
import { RaftNode, InMemoryBus, ClusterTransport, FileStorage } from 'node-raft';

// Define your state machine
class StateMachine {
  async apply(entry) {
    // Apply log entry to your state machine
    return entry;
  }

  async snapshot() {
    // Create a snapshot of current state
    return new Uint8Array();
  }

  async restore(data) {
    // Restore from snapshot
  }
}

// Create a cluster
const bus = new InMemoryBus();
const transport = new ClusterTransport(bus);
const storage = new FileStorage('./raft-data');

const node = new RaftNode(
  {
    nodeId: 'node-1',
    peers: ['node-2', 'node-3'],
    electionTimeoutMin: 150,
    electionTimeoutMax: 300,
  },
  new StateMachine(),
  transport,
  storage
);

await node.start();
```

## Configuration

The `RaftNode` constructor accepts a configuration object with the following options:

- `nodeId` (required): Unique identifier for this node
- `peers` (required): Array of peer node IDs
- `electionTimeoutMin`: Minimum election timeout in milliseconds (default: 150)
- `electionTimeoutMax`: Maximum election timeout in milliseconds (default: 300)
- `heartbeatInterval`: Leader heartbeat interval in milliseconds (default: 50)
- `rpcTimeout`: RPC timeout in milliseconds (default: 5000)
- `maxEntriesPerRequest`: Maximum log entries per AppendEntries RPC (default: 100)
- `snapshotThreshold`: Number of log entries before triggering snapshot (default: 10000)
- `snapshotRetainedEntries`: Number of entries to retain after snapshot (default: 1000)

## Storage Backends

Two storage implementations are provided:

### FileStorage

Persists state to disk using JSON files and an append-only log.

```javascript
import { FileStorage } from 'node-raft';

const storage = new FileStorage('./raft-data');
```

### MemoryStorage

Keeps all state in memory. Useful for testing.

```javascript
import { MemoryStorage } from 'node-raft';

const storage = new MemoryStorage();
```

## Transport

The `ClusterTransport` class handles RPC communication between nodes using an in-memory message bus. For production use, implement the `Transport` interface with your own networking layer.

```javascript
import { ClusterTransport, InMemoryBus } from 'node-raft';

const bus = new InMemoryBus();
const transport = new ClusterTransport(bus);
```

## API

### RaftNode

#### `start(): Promise<void>`

Initializes the node and begins participating in the cluster.

#### `stop(): Promise<void>`

Stops the node and cleans up resources.

#### `getState()`

Returns the current state of the node:

```javascript
{
  nodeId: string,
  state: NodeState,  // FOLLOWER, CANDIDATE, or LEADER
  term: number,
  commitIndex: number,
  lastApplied: number
}
```

#### `getLeader()`

Returns information about the current leader:

```javascript
{
  nodeId: string | null,
  term: number
}
```

## Testing

```bash
npm test
```

## License

ISC

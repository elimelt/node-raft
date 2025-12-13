import { EventEmitter } from 'node:events';
import type { Transport } from './Transport.js';
import type { RPCMessage, RPCResponse } from './MessageTypes.js';

type Envelope = {
  requestId: number;
  from: string;
  to: string;
  message: RPCMessage;
};

export class InMemoryBus extends EventEmitter {}

export class ClusterTransport implements Transport {
  private bus: InMemoryBus;
  private nodeId: string | null = null;
  private handler: ((message: RPCMessage & { from?: string }) => Promise<RPCResponse>) | null =
    null;
  private nextId = 1;

  constructor(bus: InMemoryBus) {
    this.bus = bus;
  }

  async initialize(nodeId: string, _peers: string[]): Promise<void> {
    this.nodeId = nodeId;
    this.bus.on(this.nodeId, async (env: Envelope, reply: (resp: RPCResponse) => void) => {
      if (!this.handler) return;
      const resp = await this.handler({ ...env.message, from: env.from });
      reply(resp);
    });
  }

  async sendRPC(peerId: string, message: RPCMessage): Promise<RPCResponse> {
    if (!this.nodeId) throw new Error('Transport not initialized');
    const requestId = this.nextId++;
    const env: Envelope = { requestId, from: this.nodeId, to: peerId, message };
    return new Promise<RPCResponse>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('RPC timeout')), 5000);
      this.bus.emit(peerId, env, (resp: RPCResponse) => {
        clearTimeout(timeout);
        resolve(resp);
      });
    });
  }

  onRPC(handler: (message: RPCMessage & { from?: string }) => Promise<RPCResponse>): void {
    this.handler = handler;
  }

  async shutdown(): Promise<void> {
    if (this.nodeId) {
      this.bus.removeAllListeners(this.nodeId);
    }
    this.nodeId = null;
    this.handler = null;
  }
}

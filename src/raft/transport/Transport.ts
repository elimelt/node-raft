import type { RPCMessage, RPCResponse } from './MessageTypes.js';

export interface Transport {
  initialize(nodeId: string, peers: string[]): Promise<void>;
  sendRPC(peerId: string, message: RPCMessage): Promise<RPCResponse>;
  onRPC(handler: (message: RPCMessage & { from?: string }) => Promise<RPCResponse>): void;
  shutdown(): Promise<void>;
}

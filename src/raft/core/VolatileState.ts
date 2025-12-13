export const NodeState = {
  FOLLOWER: 'FOLLOWER',
  CANDIDATE: 'CANDIDATE',
  LEADER: 'LEADER',
} as const;

export type NodeState = (typeof NodeState)[keyof typeof NodeState];

export type VolatileState = {
  commitIndex: number;
  lastApplied: number;
  currentState: NodeState;
};

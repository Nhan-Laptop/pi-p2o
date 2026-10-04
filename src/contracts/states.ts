import type { LifecycleState, PacketState, FindingState, RunState } from './types.js';

export const terminalLifecycleStates: readonly LifecycleState[] = ['exited', 'failed', 'timed-out', 'cancelled'];
export function isTerminalLifecycle(state: LifecycleState): boolean { return terminalLifecycleStates.includes(state); }
export const lifecycleTransitions: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  queued: ['starting', 'cancelled'],
  starting: ['running', 'waiting', 'exited', 'failed', 'timed-out', 'cancelled', 'reconciling'],
  running: ['waiting', 'exited', 'failed', 'timed-out', 'cancelled', 'reconciling'],
  waiting: ['running', 'exited', 'failed', 'timed-out', 'cancelled', 'reconciling'],
  reconciling: ['starting', 'running', 'waiting', 'exited', 'failed', 'timed-out', 'cancelled'],
  exited: [], failed: [], 'timed-out': [], cancelled: [],
};
export const packetTransitions: Readonly<Record<PacketState, readonly PacketState[]>> = {
  draft: ['ready', 'schema-valid'], ready: ['schema-valid', 'returned-for-evidence'],
  'schema-valid': ['accepted', 'returned-for-evidence'], accepted: [],
  'returned-for-evidence': ['draft', 'ready', 'schema-valid'],
};
export const findingTransitions: Readonly<Record<FindingState, readonly FindingState[]>> = {
  candidate: ['supported-static', 'reproduced', 'rejected', 'unresolved'],
  'supported-static': ['reproduced', 'rejected', 'unresolved'],
  reproduced: ['independently-validated', 'rejected', 'unresolved'],
  'independently-validated': ['rejected', 'unresolved'],
  rejected: ['candidate'], unresolved: ['candidate', 'supported-static', 'reproduced', 'rejected'],
};
export const runTransitions: Readonly<Record<RunState, readonly RunState[]>> = {
  created: ['active', 'cancelled', 'failed'], active: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['active', 'completed', 'failed', 'cancelled'], completed: [], failed: [], cancelled: [],
};
export class StateTransitionError extends Error {
  constructor(machine: string, from: string, to: string) { super(`Invalid ${machine} transition: ${from} -> ${to}`); this.name = 'StateTransitionError'; }
}
function assert<S extends string>(machine: string, transitions: Readonly<Record<S, readonly S[]>>, from: S, to: S): void {
  if (!Object.hasOwn(transitions, from) || !Object.hasOwn(transitions, to) || (from !== to && !transitions[from].includes(to))) throw new StateTransitionError(machine, from, to);
}
export const assertLifecycleTransition = (from: LifecycleState, to: LifecycleState): void => assert('lifecycle', lifecycleTransitions, from, to);
export const assertPacketTransition = (from: PacketState, to: PacketState): void => assert('packet', packetTransitions, from, to);
export const assertFindingTransition = (from: FindingState, to: FindingState): void => assert('finding', findingTransitions, from, to);
export const assertRunTransition = (from: RunState, to: RunState): void => assert('run', runTransitions, from, to);

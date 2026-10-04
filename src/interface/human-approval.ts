/**
 * Non-serializable human-confirmation authority for the single human `/p2o` entrypoint.
 *
 * The target workflow may only proceed from a genuine interactive confirmation. The value that proves that
 * confirmation is an opaque object with no enumerable string properties, tracked by identity in a
 * module-private `WeakMap`: `JSON.stringify`/`structuredClone` of it yields `{}` and a copy is useless. A tool
 * call, a replayed approval document, a model-authored packet or a hand-written `channel: 'human-command'`
 * string can never construct or smuggle one. Only `src/interface/command.ts` calls
 * `issueHumanConfirmationCapability`, and only after `ctx.ui.confirm` returned true. The port consumes the
 * capability exactly once, bound to the run, scope digest and plan digest the human actually reviewed, so an
 * approval cannot be replayed, widened or moved to another proposal.
 *
 * `src/interface/controller.ts` never issues a capability; the `p2o_*` tool dispatch path cannot reach any
 * function here.
 */
import { randomUUID } from 'node:crypto';
import { InterfaceError } from './types.js';

/** Opaque capability value carried inside `EntryHumanApproval.authority`; identified by module-private identity. */
export interface HumanConfirmationCapability {
  /** Never present: the value is recognized by WeakMap identity, never by a field. */
  readonly __humanConfirmation?: never;
}

export interface HumanConfirmationBinding {
  runId: string;
  scopeDigest: string;
  planDigest: string;
}

interface ConfirmationRecord extends HumanConfirmationBinding {
  approvalRef: string;
  approvedAt: string;
  consumed: boolean;
}

const confirmations = new WeakMap<object, ConfirmationRecord>();

const NOT_A_CONFIRMATION =
  'this approval is not a controller-issued human confirmation for this exact proposal; a tool, a JSON field or a replayed string can never authorize a run';

/**
 * Mint one single-use confirmation capability. Reachable only from the human command handler, after the
 * confirmation dialog approved the exact scope and plan the value is bound to.
 */
export function issueHumanConfirmationCapability(binding: HumanConfirmationBinding): HumanConfirmationCapability {
  for (const [label, value] of [['runId', binding.runId], ['scopeDigest', binding.scopeDigest], ['planDigest', binding.planDigest]] as const) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
      throw new InterfaceError('HUMAN_CONFIRMATION_REQUIRED', `a human confirmation needs a bounded ${label}`);
    }
  }
  // Null prototype, no enumerable string keys: serializing or cloning the value loses everything.
  const capability = Object.freeze(Object.create(null) as object);
  confirmations.set(capability, {
    runId: binding.runId,
    scopeDigest: binding.scopeDigest,
    planDigest: binding.planDigest,
    approvalRef: `human-${randomUUID()}`,
    approvedAt: new Date().toISOString(),
    consumed: false,
  });
  return capability as HumanConfirmationCapability;
}

/** Read the audit identity of an issued capability without consuming it. */
export function humanConfirmationRef(capability: unknown): { approvalRef: string; approvedAt: string } {
  const record = capability !== null && typeof capability === 'object' ? confirmations.get(capability) : undefined;
  if (!record) throw new InterfaceError('HUMAN_CONFIRMATION_REQUIRED', NOT_A_CONFIRMATION);
  return { approvalRef: record.approvalRef, approvedAt: record.approvedAt };
}

/**
 * Validate and consume one confirmation capability for exactly one sealed proposal. Throws
 * `HUMAN_CONFIRMATION_REQUIRED` for a missing, forged, mismatched or already-used value.
 */
export function consumeHumanConfirmationCapability(capability: unknown, binding: HumanConfirmationBinding): { approvalRef: string; approvedAt: string } {
  if (capability === null || typeof capability !== 'object') throw new InterfaceError('HUMAN_CONFIRMATION_REQUIRED', NOT_A_CONFIRMATION);
  const record = confirmations.get(capability);
  if (!record) throw new InterfaceError('HUMAN_CONFIRMATION_REQUIRED', NOT_A_CONFIRMATION);
  if (record.consumed) {
    throw new InterfaceError('HUMAN_CONFIRMATION_REQUIRED', 'this human confirmation was already used for a run; confirm the current proposal again');
  }
  if (record.runId !== binding.runId || record.scopeDigest !== binding.scopeDigest || record.planDigest !== binding.planDigest) {
    throw new InterfaceError('HUMAN_CONFIRMATION_REQUIRED', 'this human confirmation was issued for a different run, scope digest or plan digest');
  }
  record.consumed = true;
  return { approvalRef: record.approvalRef, approvedAt: record.approvedAt };
}

/** Read-only inspection for diagnostics and tests; it never consumes or widens a capability. */
export function isHumanConfirmationCapability(value: unknown): boolean {
  return value !== null && typeof value === 'object' && confirmations.has(value);
}

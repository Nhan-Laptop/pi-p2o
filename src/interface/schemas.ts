import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type Static, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { InterfaceError } from './types.js';

const closed = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' });
const path = Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\\x00-\\x1f\\x7f]+$' });
const selection = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 160, pattern: '^[-A-Za-z0-9_.:/]+$' }),
  model: Type.String({ minLength: 1, maxLength: 240, pattern: '^[-A-Za-z0-9_.:/]+$' }),
  thinking: StringEnum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const),
}, closed);
const startFields = {
  manifestPath: path,
  mode: StringEnum(['fixture', 'assessment'] as const, {
    description: 'Explicit fixture (lab/read-only artifact only) or assessment path. Neither a mode, target list nor tool call grants permission.',
  }),
  selection: Type.Optional(selection),
  runtime: Type.Optional(StringEnum(['headless', 'herdr'] as const)),
};
const pageFields = {
  runId: id,
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
};
export const schemas = {
  start: Type.Object(startFields, closed),
  resume: Type.Object({ ...startFields, runId: id }, closed),
  preflight: Type.Object(startFields, closed),
  doctor: Type.Object(startFields, closed),
  status: Type.Object({ runId: id }, closed),
  stop: Type.Object({ runId: id, reason: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })) }, closed),
  tasks: Type.Object(pageFields, closed),
  evidence: Type.Object({ ...pageFields, evidenceId: Type.Optional(id) }, closed),
  report: Type.Object({ runId: id, format: Type.Optional(StringEnum(['json', 'markdown'] as const)) }, closed),
  events: Type.Object({
    runId: id,
    afterSequence: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }, closed),
  /** Owner-gated model switch: the supervisor/authority decides; this schema grants nothing. */
  switch_model: Type.Object({
    attemptId: id,
    selection,
    reason: Type.String({ minLength: 1, maxLength: 4096 }),
  }, closed),
  /** Supervisor-adjudicated subtask request; scope/budget/role narrowing is decided by the supervisor. */
  subtask: Type.Object({
    attemptId: id,
    question: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 8192 }),
      ifTrue: Type.String({ minLength: 1, maxLength: 4096 }),
      ifFalse: Type.String({ minLength: 1, maxLength: 4096 }),
    }, closed),
    targetIds: Type.Array(id, { minItems: 1, maxItems: 64 }),
    actor: Type.Object({ id, privileges: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 64 }) }, closed),
    inputRevision: Type.String({ minLength: 1, maxLength: 512 }),
    role: StringEnum(['worker', 'verifier'] as const),
    reason: Type.String({ minLength: 1, maxLength: 4096 }),
    budgets: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.Number({ minimum: 0 }))),
    skills: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 })),
    allowedActions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 })),
    requiredCapabilities: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 })),
    dependencyTaskIds: Type.Optional(Type.Array(id, { maxItems: 64 })),
  }, closed),
  /**
   * Planner control plane. `approve` takes the owner approval document path plus the exact proposal digest; the
   * tool cannot fabricate an approval — only an owner-authored document held by the owner authority authorizes.
   */
  plan: Type.Object({
    action: StringEnum(['propose', 'read', 'approve'] as const),
    runId: id,
    proposalPath: Type.Optional(path),
    proposalId: Type.Optional(id),
    proposalDigest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$', maxLength: 64 })),
    approvalPath: Type.Optional(path),
  }, closed),
  dashboard: Type.Object({
    action: StringEnum(['open', 'close'] as const),
    enabled: Type.Optional(Type.Boolean({ description: 'Must be true to opt in to a localhost read-only dashboard.' })),
    runId: Type.Optional(id),
  }, closed),
  /** Session-bound foreground planning/control; never accepts authority, paths or a launch action. */
  orchestrate: Type.Object({
    runId: id,
    action: StringEnum(['context', 'propose', 'watch', 'finish'] as const),
    afterRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    draft: Type.Optional(Type.Object({
      steps: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 16 }),
      ownerMenu: Type.Optional(Type.Array(Type.Object({ taskId: id, observationId: id }, closed), { minItems: 1, maxItems: 32 })),
      generatedRequests: Type.Optional(Type.Array(Type.Unknown(), { minItems: 1, maxItems: 16 })),
    }, closed)),
  }, closed),
} as const;
export type Action = keyof typeof schemas;
export type Input<A extends Action> = Static<(typeof schemas)[A]>;

const validators = new Map<TSchema, ReturnType<typeof Compile>>();
/** Strictly validate on every call, including commands and post-tool_call mutations. No coercion. */
export function validate<A extends Action>(action: A, input: unknown): Input<A> {
  assertPlainJson(input);
  const schema = schemas[action];
  let validator = validators.get(schema);
  if (!validator) { validator = Compile(schema); validators.set(schema, validator); }
  if (!validator.Check(input)) throw new InterfaceError('INVALID_INPUT', `p2o_${action} arguments do not match its schema`);
  const value = input as Input<A>;
  if (action === 'orchestrate') {
    const o = value as Input<'orchestrate'>;
    if ((o.action === 'propose') !== (o.draft !== undefined) || (o.action === 'watch') !== (o.afterRevision !== undefined)) {
      throw new InterfaceError('INVALID_INPUT', 'propose requires only draft; watch requires only afterRevision; context/finish accept neither');
    }
    if (o.draft && (o.draft.ownerMenu === undefined) === (o.draft.generatedRequests === undefined)) {
      throw new InterfaceError('INVALID_INPUT', 'a draft must name exactly one ownerMenu or generatedRequests flavour');
    }
  }
  if (action === 'dashboard') {
    const d = value as Input<'dashboard'>;
    if (d.action === 'open' && (d.enabled !== true || !d.runId)) {
      throw new InterfaceError('DASHBOARD_OPT_IN_REQUIRED', 'open requires enabled:true and runId');
    }
    if (d.action === 'close' && (d.enabled !== undefined || d.runId !== undefined)) {
      throw new InterfaceError('INVALID_INPUT', 'dashboard close only accepts action');
    }
  }
  if (action === 'plan') {
    const p = value as Input<'plan'>;
    if (p.action === 'propose' && (!p.proposalPath || p.approvalPath !== undefined || p.proposalDigest !== undefined)) {
      throw new InterfaceError('INVALID_INPUT', 'plan propose requires proposalPath and accepts no approval fields');
    }
    if (p.action === 'approve' && (!p.approvalPath || !p.proposalDigest)) {
      throw new InterfaceError('INVALID_INPUT', 'plan approve requires proposalDigest and approvalPath');
    }
    if (p.action === 'read' && (p.proposalPath !== undefined || p.approvalPath !== undefined || p.proposalDigest !== undefined)) {
      throw new InterfaceError('INVALID_INPUT', 'plan read only accepts runId and an optional proposalId');
    }
  }
  return value;
}

export function parseCommand<A extends Action>(action: A, args: string): Input<A> {
  if (Buffer.byteLength(args) > 16_384) throw new InterfaceError('INVALID_INPUT', 'command arguments exceed 16KiB');
  let value: unknown;
  try { value = JSON.parse(args.trim() || '{}'); }
  catch { throw new InterfaceError('INVALID_JSON', `Usage: /p2o_${action} {"key":"value"} (strict JSON, not shell arguments)`); }
  return validate(action, value);
}

function assertPlainJson(value: unknown): void {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): void {
    if (++nodes > 500 || depth > 8) throw new InterfaceError('INVALID_INPUT', 'arguments are too complex');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') {
      bytes += Buffer.byteLength(v);
      if (bytes > 16_384) throw new InterfaceError('INVALID_INPUT', 'arguments exceed 16KiB');
      return;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (Array.isArray(v)) {
      if (seen.has(v)) throw new InterfaceError('INVALID_INPUT', 'arguments must be acyclic JSON values');
      seen.add(v);
      for (const item of v) visit(item, depth + 1);
      seen.delete(v);
      return;
    }
    if (typeof v !== 'object' || !v || Object.getPrototypeOf(v) !== Object.prototype || seen.has(v)) {
      throw new InterfaceError('INVALID_INPUT', 'arguments must be plain acyclic JSON values');
    }
    seen.add(v);
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new InterfaceError('INVALID_INPUT', 'unsafe argument key');
      }
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new InterfaceError('INVALID_INPUT', 'argument accessors are forbidden');
      visit(descriptor.value, depth + 1);
    }
    seen.delete(v);
  }
  visit(value, 0);
}

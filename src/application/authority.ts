import { digestJson, planApprovalDocumentSchema, type PlanApproval, type PlanApprovalDocument, type PlanProposal, type RunManifest } from '../contracts/index.js';
import {
  planRequestApprovalDocumentSchema,
  type PlanRequestApproval,
  type PlanRequestApprovalDocument,
  type PlanRequestProposal,
} from '../contracts/plan-request.js';
import {
  SupervisorError, type Approval, type Authority, type ControlApproval, type ControlTransfer, type ModelSwitchApproval,
  type ModelSwitchProposal, type ReplacementApproval, type ReplacementProposal, type RunAdmission, type TaskApproval, type TaskProposal,
} from '../orchestrator/index.js';
import type { OwnerGrant } from './types.js';
import { fail } from './validation.js';
import {
  assertCredentialAccount, credentialAccountSlot, credentialRef, CredentialDeniedError,
  type CredentialDenialCode,
} from '../policy/targets.js';
import type { Action, Decision } from '../policy/types.js';

/** Re-exported so the composition/interface layers can name credential denial codes without importing policy internals. */
export type { CredentialDenialCode } from '../policy/targets.js';

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) fail('invalid-grant', `${label} must be a bounded string`);
  return value;
};

/**
 * Optional owner gate for generated-request proposals. The owner holds its own copy of every approved
 * approval document; an absent or empty list approves nothing and the model can never append to it.
 */
export interface RequestApprovalAuthority {
  approveRequestProposal(proposal: Readonly<PlanRequestProposal>, document: Readonly<PlanRequestApprovalDocument>, context: { runId: string; now: string; authorizationRef: string }): Promise<PlanRequestApproval>;
}

function requestApprovalFor(approvals: Map<string, PlanRequestApprovalDocument>, proposal: Readonly<PlanRequestProposal>, document: Readonly<PlanRequestApprovalDocument>, context: { runId: string; now: string; authorizationRef: string }): PlanRequestApproval {
  const ownerCopy = approvals.get(digestJson(document));
  if (!ownerCopy) throw new SupervisorError('permission-denied', 'Request approval document is not in the owner-approved grant document');
  const proposalDigest = digestJson(proposal);
  if (ownerCopy.proposalDigest !== proposalDigest || ownerCopy.proposalId !== proposal.proposalId) {
    throw new SupervisorError('plan-digest-mismatch', 'Owner approved a different generated-request proposal digest or identity');
  }
  if (ownerCopy.runId !== proposal.runId || ownerCopy.runId !== context.runId) throw new SupervisorError('permission-denied', 'Request approval belongs to another run');
  if (ownerCopy.expiresAt <= context.now) throw new SupervisorError('permission-expired', 'Request approval has expired');
  if (ownerCopy.approvedAt > context.now) throw new SupervisorError('plan-approval-future', 'Request approval is future-dated');
  return Object.freeze({
    allowed: true, digest: proposalDigest, proposalId: proposal.proposalId, proposalDigest,
    approvalId: ownerCopy.approvalId, approvalDocumentDigest: digestJson(ownerCopy),
    authorizationRef: context.authorizationRef, approvedBy: ownerCopy.approvedBy,
    reference: ownerCopy.reference, expiresAt: ownerCopy.expiresAt,
  });
}

/**
 * Owner gate for generated-request proposals, built from the owner's own approved-document list. It is the
 * same separation-of-duties model as plan batch approval: the exact canonical proposal digest must appear in
 * the owner's copy, inside the run and inside the unexpired window. There is no self-approval form.
 */
export function createRequestApprovalAuthority(options: { approvals: readonly PlanRequestApprovalDocument[]; now?: () => number }): RequestApprovalAuthority {
  if (!options || !Array.isArray(options.approvals)) fail('invalid-grant', 'A bounded owner approval document list is required');
  const now = options.now ?? Date.now;
  const approvals = new Map<string, PlanRequestApprovalDocument>();
  for (const entry of options.approvals) {
    const parsed = planRequestApprovalDocumentSchema.parse(entry);
    const digest = digestJson(parsed);
    if (approvals.has(digest)) fail('invalid-grant', 'Duplicate owner request approval document');
    approvals.set(digest, parsed);
  }
  return Object.freeze({
    async approveRequestProposal(proposal: Readonly<PlanRequestProposal>, document: Readonly<PlanRequestApprovalDocument>, context: { runId: string; now: string; authorizationRef: string }): Promise<PlanRequestApproval> {
      // The gate's own clock is authoritative: a caller cannot move the approval window by supplying `now`.
      return requestApprovalFor(approvals, proposal, document, { ...context, now: new Date(now()).toISOString() });
    },
  });
}
/**
 * Owner-approved authority. It holds its own copies of the approved run/task/replacement proposals and
 * approves only an exact canonical-digest match inside the current authorization window. Everything else
 * is denied with an explicit error; there is no fallback approval and workers can never widen it.
 */
export function createOwnerAuthority(grant: OwnerGrant, options: { now?: () => number } = {}): Authority & RequestApprovalAuthority {
  if (!grant || grant.version !== 1) fail('invalid-grant', 'Owner grant version 1 is required');
  if (!Array.isArray(grant.runs) || grant.runs.length === 0) fail('invalid-grant', 'At least one approved run proposal is required');
  if (!Array.isArray(grant.tasks)) fail('invalid-grant', 'An approved task list is required');
  const now = options.now ?? Date.now;
  const runs = new Map<string, RunAdmission>();
  for (const run of grant.runs) {
    const digest = digestJson(run);
    if (runs.has(digest)) fail('invalid-grant', 'Duplicate approved run proposal');
    if (run.mode !== 'managed') fail('invalid-grant', 'Plan-mode runs cannot be owner-approved for execution');
    runs.set(digest, run);
  }
  const tasks = new Map<string, { entry: OwnerGrant['tasks'][number]; digest: string }>();
  for (const entry of grant.tasks) {
    const digest = digestJson(entry.proposal);
    if (tasks.has(digest)) fail('invalid-grant', 'Duplicate approved task proposal');
    tasks.set(digest, { entry, digest });
  }
  const replacements = new Map<string, { reference: string; expiresAt: string; digest: string }>();
  for (const entry of grant.replacements ?? []) {
    replacements.set(digestJson(entry.proposal), { reference: text(entry.reference, 'replacement reference'), expiresAt: text(entry.expiresAt, 'replacement expiry'), digest: digestJson(entry.proposal) });
  }
  const switchProposals = new Map<string, { reference: string; expiresAt: string; attemptId: string }>();
  for (const entry of grant.modelSwitches ?? []) {
    const digest = digestJson(entry.proposal);
    if (switchProposals.has(digest)) fail('invalid-grant', 'Duplicate approved model-switch proposal');
    switchProposals.set(digest, { reference: text(entry.reference, 'model-switch reference'), expiresAt: text(entry.expiresAt, 'model-switch expiry'), attemptId: text(entry.proposal.attemptId, 'model-switch attemptId') });
  }
  const planApprovals = new Map<string, PlanApprovalDocument>();
  for (const planEntry of grant.planApprovals ?? []) {
    const parsed = planApprovalDocumentSchema.parse(planEntry);
    const digest = digestJson(parsed);
    if (planApprovals.has(digest)) fail('invalid-grant', 'Duplicate approved plan approval document');
    planApprovals.set(digest, parsed);
  }
  // Generated-request approvals are read structurally: `OwnerGrant` lives outside this workstream's owned
  // files, so the field is optional and an absent/empty list approves nothing (the same rule as plans).
  const requestApprovals = new Map<string, PlanRequestApprovalDocument>();
  const requestEntries = (grant as { requestApprovals?: unknown }).requestApprovals;
  if (requestEntries !== undefined) {
    if (!Array.isArray(requestEntries) || requestEntries.length > 256) fail('invalid-grant', 'Owner grant request approvals must be a bounded array');
    for (const entry of requestEntries) {
      const parsed = planRequestApprovalDocumentSchema.parse(entry);
      const digest = digestJson(parsed);
      if (requestApprovals.has(digest)) fail('invalid-grant', 'Duplicate owner request approval document');
      requestApprovals.set(digest, parsed);
    }
  }
  const transfer = grant.controlTransfer;

  function approvalReference(scope: string, digest: string): string {
    return `owner-approval:${scope}:${digest.slice(0, 16)}`;
  }

  return Object.freeze({
    async verifyRun(proposal: Readonly<RunAdmission>): Promise<Approval> {
      const digest = digestJson(proposal);
      const approved = runs.get(digest);
      if (!approved) throw new SupervisorError('permission-denied', 'Run proposal is not in the owner-approved grant document');
      const manifest = approved.manifest;
      return {
        allowed: true,
        digest,
        authorizationRef: manifest.authorization.reference,
        approvedBy: manifest.authorization.authorizedBy,
        reference: approvalReference('run', digest),
        expiresAt: manifest.authorization.expiresAt,
      };
    },
    async approveTask(proposal: Readonly<TaskProposal>, run: Readonly<RunManifest>): Promise<TaskApproval> {
      const digest = digestJson(proposal);
      const approved = tasks.get(digest);
      if (!approved) throw new SupervisorError('permission-denied', 'Task proposal is not in the owner-approved grant document');
      const manifest = approved.entry.proposal.manifest;
      if (manifest.runId !== run.runId) throw new SupervisorError('permission-denied', 'Approved task belongs to another run');
      const expiresAt = approved.entry.expiresAt ?? run.authorization.expiresAt;
      return {
        allowed: true,
        digest,
        authorizationRef: run.authorization.reference,
        approvedBy: run.authorization.authorizedBy,
        reference: approvalReference('task', digest),
        expiresAt,
        toolPolicy: approved.entry.toolPolicy,
        boundaryReceipt: approved.entry.boundaryReceipt,
      };
    },
    async approveReplacement(proposal: Readonly<ReplacementProposal>, run: Readonly<RunManifest>): Promise<ReplacementApproval> {
      const digest = digestJson(proposal);
      const approved = replacements.get(digest);
      if (!approved) throw new SupervisorError('permission-denied', 'Replacement proposal is not in the owner-approved grant document');
      if (approved.expiresAt <= new Date(now()).toISOString()) throw new SupervisorError('permission-expired', 'Replacement approval has expired');
      return {
        allowed: true,
        digest,
        authorizationRef: run.authorization.reference,
        approvedBy: run.authorization.authorizedBy,
        reference: approved.reference,
        expiresAt: approved.expiresAt,
        parentAttemptId: proposal.attemptId,
      };
    },
    async approveModelSwitch(proposal: Readonly<ModelSwitchProposal>, run: Readonly<RunManifest>): Promise<ModelSwitchApproval> {
      const digest = digestJson(proposal);
      const approved = switchProposals.get(digest);
      if (!approved) throw new SupervisorError('permission-denied', 'Model-switch proposal is not in the owner-approved grant document');
      if (approved.expiresAt <= new Date(now()).toISOString()) throw new SupervisorError('permission-expired', 'Model-switch approval has expired');
      if (proposal.runId !== run.runId || approved.attemptId !== proposal.attemptId) throw new SupervisorError('permission-denied', 'Model-switch approval is bound to a different run or attempt');
      return {
        allowed: true,
        digest,
        authorizationRef: run.authorization.reference,
        approvedBy: run.authorization.authorizedBy,
        reference: approved.reference,
        expiresAt: approved.expiresAt,
        attemptId: proposal.attemptId,
      };
    },
    async transferControl(proposal: Readonly<ControlTransfer>): Promise<ControlApproval> {
      if (!transfer) throw new SupervisorError('permission-denied', 'Control transfer is not owner-approved');
      if (transfer.expiresAt <= new Date(now()).toISOString()) throw new SupervisorError('permission-expired', 'Control-transfer approval has expired');
      return {
        allowed: true,
        digest: digestJson(proposal),
        reference: transfer.reference,
        previousControllerFenced: transfer.previousControllerFenced,
      };
    },
    /**
     * Batch plan approval. Only the owner grant's own copy of the exact approval document can authorize, and
     * only when its recorded proposal digest equals the canonical digest of the whole proposal. Any altered
     * proposal, foreign document, wrong run or expired window denies with no fallback.
     */
    async approvePlan(proposal: Readonly<PlanProposal>, approval: Readonly<PlanApprovalDocument>, context: { runId: string; now: string }): Promise<PlanApproval> {
      const document = planApprovals.get(digestJson(approval));
      if (!document) throw new SupervisorError('permission-denied', 'Plan approval document is not in the owner-approved grant document');
      const proposalDigest = digestJson(proposal);
      if (document.proposalDigest !== proposalDigest || document.proposalId !== proposal.proposalId) {
        throw new SupervisorError('plan-digest-mismatch', 'Owner approved a different plan proposal digest or identity');
      }
      if (document.runId !== proposal.run.runId || document.runId !== context.runId) throw new SupervisorError('permission-denied', 'Plan approval belongs to another run');
      if (document.expiresAt <= context.now) throw new SupervisorError('permission-expired', 'Plan approval has expired');
      return Object.freeze({
        allowed: true, digest: proposalDigest, proposalId: proposal.proposalId, proposalDigest,
        approvalId: document.approvalId, approvalDocumentDigest: digestJson(document),
        authorizationRef: proposal.run.scope.authorizationRef, approvedBy: document.approvedBy,
        reference: document.reference, expiresAt: document.expiresAt,
      });
    },
    /**
     * Generated-request batch approval. Identical separation-of-duties rules as plan approval: the owner
     * grant's own copy of the exact document must match the canonical digest of the whole request proposal.
     */
    async approveRequestProposal(proposal: Readonly<PlanRequestProposal>, document: Readonly<PlanRequestApprovalDocument>, context: { runId: string; now: string; authorizationRef: string }): Promise<PlanRequestApproval> {
      return requestApprovalFor(requestApprovals, proposal, document, context);
    },
  }) satisfies Authority & RequestApprovalAuthority;
}

/** Shape check for a grant document before any authority is built. Unknown fields are not silently accepted. */
export function assertOwnerGrant(grant: unknown): asserts grant is OwnerGrant {
  if (!grant || typeof grant !== 'object') fail('invalid-grant', 'Owner grant must be an object');
  const value = grant as Record<string, unknown>;
  const allowed = ['version', 'runs', 'tasks', 'replacements', 'modelSwitches', 'planApprovals', 'requestApprovals', 'controlTransfer'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('invalid-grant', `unknown owner grant field: ${key}`);
  if (value.version !== 1) fail('invalid-grant', 'Owner grant version must be 1');
  if (!Array.isArray(value.runs) || value.runs.length === 0) fail('invalid-grant', 'Owner grant requires approved run proposals');
  if (!Array.isArray(value.tasks)) fail('invalid-grant', 'Owner grant requires an approved task list');
  if (value.planApprovals !== undefined) {
    if (!Array.isArray(value.planApprovals) || value.planApprovals.length > 256) fail('invalid-grant', 'Owner grant plan approvals must be a bounded array');
    for (const entry of value.planApprovals) {
      try { planApprovalDocumentSchema.parse(entry); }
      catch { fail('invalid-grant', 'Owner grant contains an invalid plan approval document'); }
    }
  }
  if (value.requestApprovals !== undefined) {
    if (!Array.isArray(value.requestApprovals) || value.requestApprovals.length > 256) fail('invalid-grant', 'Owner grant request approvals must be a bounded array');
    for (const entry of value.requestApprovals) {
      try { planRequestApprovalDocumentSchema.parse(entry); }
      catch { fail('invalid-grant', 'Owner grant contains an invalid request approval document'); }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// [T2] Credential-owning boundary for authenticated target access.
//
// Resolution happens at dispatch time, keyed only by the *approved* account of a policy decision.
// Missing, expired, unknown or mis-bound credentials deny with an explicit code and no request is
// issued. The serializable identity carries a stable digest reference; the secret exists only inside
// the single-use `headers()` closure returned for the in-flight request.
// ---------------------------------------------------------------------------------------------
export interface OwnerCredentialEntry {
  /** Account this material belongs to; a store that returns another account's entry denies. */
  readonly accountId: string;
  /** Rotation identity of the secret. */
  readonly version: string;
  /** The secret. Owner-store only: never logged, receipted, serialized or handed to a worker. */
  readonly secret: string;
  /** ISO expiry of the credential material itself. */
  readonly expiresAt: string;
  /** Approved target bindings for this account. */
  readonly targetIds: string[];
  /** Optional action narrowing inside the approved binding. */
  readonly actions?: Action[];
  /** Injection header at the credential-owning boundary; defaults to Bearer authorization. */
  readonly header?: string;
  readonly scheme?: string;
}

/** The owner store is the only component allowed to answer a credential lookup. */
export interface OwnerCredentialStore {
  read(accountId: string): Promise<OwnerCredentialEntry | undefined>;
  list(): Promise<readonly string[]>;
}

export interface CredentialIdentity {
  readonly accountId: string;
  readonly version: string;
  /** Stable digest reference to the credential material; never the secret. */
  readonly ref: string;
  readonly expiresAt: string;
}

export interface ResolvedTargetCredential extends CredentialIdentity {
  readonly header: string;
  /** Dispatch-time material for exactly one in-flight request; never receipt or serialize this value. */
  headers(): Record<string, string>;
}

export interface CredentialAvailabilityInput { accountId: string; targetId: string; action: string; at: string }
export type CredentialAvailabilityResult =
  | { ok: true; identity: CredentialIdentity }
  | { ok: false; code: CredentialDenialCode; message: string };

export interface CredentialAuthority {
  accounts(): Promise<readonly string[]>;
  availability(input: CredentialAvailabilityInput): Promise<CredentialAvailabilityResult>;
  /** Resolution requires the policy decision: a worker can never name a credential freely. */
  resolveAtDispatch(decision: Decision, at: string): Promise<ResolvedTargetCredential>;
}

const credentialVersionPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

export function createCredentialAuthority(options: { store: OwnerCredentialStore }): CredentialAuthority {
  if (!options?.store || typeof options.store.read !== 'function' || typeof options.store.list !== 'function') {
    fail('invalid-grant', 'A credential-owning owner store is required');
  }
  const store = options.store;
  async function lookup(input: CredentialAvailabilityInput): Promise<{ ok: true; entry: OwnerCredentialEntry; identity: CredentialIdentity } | { ok: false; code: CredentialDenialCode; message: string }> {
    let slot: string;
    try { slot = credentialAccountSlot(input.accountId); }
    catch (error) { return { ok: false, code: 'CREDENTIAL_UNKNOWN', message: error instanceof Error ? error.message : 'invalid account identity' }; }
    if (!Number.isFinite(Date.parse(input.at))) return { ok: false, code: 'CREDENTIAL_UNKNOWN', message: 'dispatch instant is not a valid timestamp' };
    const entry = await store.read(input.accountId);
    if (!entry) return { ok: false, code: 'CREDENTIAL_MISSING', message: `no owner credential is provisioned for ${slot}` };
    if (entry.accountId !== input.accountId) return { ok: false, code: 'CREDENTIAL_UNKNOWN', message: `owner store returned material for a different account than ${slot}` };
    if (typeof entry.version !== 'string' || !credentialVersionPattern.test(entry.version)) {
      return { ok: false, code: 'CREDENTIAL_VERSION_MISMATCH', message: `account ${input.accountId} has an invalid credential version identity` };
    }
    if (!Array.isArray(entry.targetIds) || !entry.targetIds.includes(input.targetId)) {
      return { ok: false, code: 'CREDENTIAL_TARGET_MISMATCH', message: `credential for ${input.accountId} is not bound to target ${input.targetId}` };
    }
    if (entry.actions && !entry.actions.includes(input.action as Action)) {
      return { ok: false, code: 'CREDENTIAL_ACTION_DENIED', message: `credential for ${input.accountId} is not permitted for action ${input.action}` };
    }
    if (!Number.isFinite(Date.parse(entry.expiresAt)) || !(Date.parse(entry.expiresAt) > Date.parse(input.at))) {
      return { ok: false, code: 'CREDENTIAL_EXPIRED', message: `credential for ${input.accountId}@${entry.version} has expired` };
    }
    const identity = Object.freeze({ accountId: input.accountId, version: entry.version, ref: credentialRef(input.accountId, entry.version, entry.secret), expiresAt: entry.expiresAt });
    return { ok: true, entry, identity };
  }

  return Object.freeze({
    async accounts(): Promise<readonly string[]> {
      const listed = await store.list();
      return Object.freeze([...new Set(listed.filter((accountId) => typeof accountId === 'string' && accountId.length > 0 && accountId.length <= 128))]);
    },
    async availability(input: CredentialAvailabilityInput): Promise<CredentialAvailabilityResult> {
      const result = await lookup(input);
      return result.ok ? { ok: true, identity: result.identity } : { ok: false, code: result.code, message: result.message };
    },
    async resolveAtDispatch(decision: Decision, at: string): Promise<ResolvedTargetCredential> {
      const approved = assertCredentialAccount(decision, at);
      const result = await lookup({ accountId: approved.accountId, targetId: approved.targetId, action: approved.action, at });
      if (!result.ok) throw new CredentialDeniedError(result.code, approved.accountId, result.message);
      const header = result.entry.header ?? 'authorization';
      const scheme = result.entry.scheme ?? (header.toLowerCase() === 'authorization' ? 'Bearer ' : '');
      const secret = result.entry.secret;
      return Object.freeze({ ...result.identity, header, headers: (): Record<string, string> => ({ [header]: `${scheme}${secret}` }) });
    },
  }) satisfies CredentialAuthority;
}

/** Dispatch-time shape check; the caller owns the in-flight request, not the credential. */
export function assertCredentialIdentity(input: unknown): CredentialIdentity {
  const value = input as Partial<CredentialIdentity> | undefined;
  if (!value || typeof value.accountId !== 'string' || typeof value.version !== 'string' || typeof value.ref !== 'string' || typeof value.expiresAt !== 'string') {
    throw new CredentialDeniedError('CREDENTIAL_VERSION_MISMATCH', '', 'credential identity is incomplete');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(value.ref)) throw new CredentialDeniedError('CREDENTIAL_VERSION_MISMATCH', value.accountId, 'credential reference is not a stable digest reference');
  return Object.freeze({ accountId: value.accountId, version: value.version, ref: value.ref, expiresAt: value.expiresAt });
}

/** Current controller instant as a UTC timestamp, for `CredentialAvailabilityInput.at`. */
export function controllerInstant(now: () => number = Date.now): string { return new Date(now()).toISOString(); }

/**
 * Owner approval documents for the entry workflow.
 *
 * Two sources, one decision maker. `createOwnerDirectoryAuthority` *finds* documents the owner authored as
 * canonical, owner-only, same-UID regular files under one owner approval directory. `createOwnerApprovalPort`
 * also *creates* the exact artifact for one sealed proposal, but only from a consumed human-confirmation
 * capability that `src/interface/human-approval.ts` minted after `ctx.ui.confirm`; it never overwrites an
 * existing owner document and never invents scope, digests or counts.
 *
 * Both are only inputs to the existing owner gate (`createOwnerAuthority`), which still performs every
 * membership, binding, window and canonical-digest check before the ledger records an approval.
 *
 * Path convention (documented in `docs/USAGE.md`):
 *
 *   <approvalDirectory>/plan-approval-<proposalDigest>.json      PlanApprovalDocument      (owner-menu)
 *   <approvalDirectory>/request-approval-<proposalDigest>.json   PlanRequestApprovalDocument (generated)
 */
import { mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { planApprovalDocumentSchema, type PlanApproval } from '../../contracts/index.js';
import { planRequestApprovalDocumentSchema } from '../../contracts/plan-request.js';
import { createOwnerAuthority, type RequestApprovalAuthority } from '../authority.js';
import type { OwnerGrant } from '../types.js';
import type { Authority } from '../../orchestrator/index.js';
import type { PlanApprovalDocument } from '../../contracts/index.js';
import type { PlanRequestApprovalDocument } from '../../contracts/plan-request.js';
import { entryFail } from './errors.js';
import { readOwnerDocument } from './documents.js';
import type { EntryApprovalMintRequest, EntryApprovalPort } from './types.js';

const DIGEST = /^[a-f0-9]{64}$/;

export type EntryOwnerApprovalKind = 'plan' | 'request';

/** The exact path an owner authors for one plan/request approval, derived from the sealed proposal digest. */
export function entryOwnerApprovalPath(directory: string, kind: EntryOwnerApprovalKind, proposalDigest: string): string {
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error(`the owner approval directory must be a canonical absolute path, saw ${directory}`);
  }
  if (!DIGEST.test(proposalDigest)) throw new Error('an owner approval path needs the exact proposal digest');
  return join(directory, `${kind}-approval-${proposalDigest}.json`);
}

/** A path provider for `EntryGeneratedWiring.ownerDocumentPath` / `EntryOwnerMenuWiring.ownerDocumentPath`. */
export function ownerDocumentPathFor(directory: string, kind: EntryOwnerApprovalKind): (proposalDigest: string) => string {
  return proposalDigest => entryOwnerApprovalPath(directory, kind, proposalDigest);
}

function present(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch { return false; }
}

/**
 * Wrap the composition's owner authority so that the *owner-authored* approval directory is an additional
 * source of approval documents. The inner gate is still the only decision maker: the wrapper adds one
 * document (when the owner authored one for exactly this proposal digest) and lets `createOwnerAuthority`
 * verify the binding, window and canonical bytes. `verifyRun`/`approveTask`/`approveReplacement` are
 * delegated unchanged, so run and task admission can never be widened by this module.
 */
export function createOwnerDirectoryAuthority(options: {
  grant: OwnerGrant;
  directory: string;
  now?: () => number;
}): Authority & RequestApprovalAuthority {
  const inner = createOwnerAuthority(options.grant, options.now ? { now: options.now } : {});
  const basePlanApprovals = options.grant.planApprovals ? [...options.grant.planApprovals] : [];
  const baseRequestApprovals = (options.grant as { requestApprovals?: PlanRequestApprovalDocument[] }).requestApprovals ?? [];
  const now = options.now ?? Date.now;
  const rebuilt = (planApprovals: readonly PlanApprovalDocument[], requestApprovals: readonly PlanRequestApprovalDocument[]) => createOwnerAuthority({
    ...options.grant,
    ...(planApprovals.length ? { planApprovals: [...planApprovals] } : {}),
    ...(requestApprovals.length ? { requestApprovals: [...requestApprovals] } : {}),
  }, { now });

  const directoryPlanApproval = (proposalDigest: string): PlanApprovalDocument | undefined => {
    const path = entryOwnerApprovalPath(options.directory, 'plan', proposalDigest);
    if (!present(path)) return undefined;
    return planApprovalDocumentSchema.parse(readOwnerDocument(path, 'owner plan approval'));
  };

  const directoryRequestApproval = (proposalDigest: string): PlanRequestApprovalDocument | undefined => {
    const path = entryOwnerApprovalPath(options.directory, 'request', proposalDigest);
    if (!present(path)) return undefined;
    return planRequestApprovalDocumentSchema.parse(readOwnerDocument(path, 'owner generated-request approval'));
  };

  return Object.freeze({
    verifyRun: (proposal: Readonly<Parameters<Authority['verifyRun']>[0]>) => inner.verifyRun(proposal),
    approveTask: (proposal: Readonly<Parameters<Authority['approveTask']>[0]>, run: Readonly<Parameters<Authority['approveTask']>[1]>) => inner.approveTask(proposal, run),
    approveReplacement: (proposal: Readonly<Parameters<Authority['approveReplacement']>[0]>, run: Readonly<Parameters<Authority['approveReplacement']>[1]>) => inner.approveReplacement(proposal, run),
    async approvePlan(proposal: Parameters<NonNullable<Authority['approvePlan']>>[0], document: PlanApprovalDocument, context: { runId: string; now: string }): Promise<PlanApproval> {
      const extra = directoryPlanApproval(document.proposalDigest);
      // The directory only ever *adds* one owner-authored copy; the rebuilt gate still checks that the
      // presented document is a canonical member of the owner-approved set and that every binding matches.
      const gate = extra ? rebuilt([...basePlanApprovals, extra], baseRequestApprovals) : inner;
      if (!gate.approvePlan) throw new Error('owner authority exposes no plan approval');
      return gate.approvePlan(proposal, document, context);
    },
    async approveRequestProposal(proposal, document, context) {
      const extra = directoryRequestApproval(document.proposalDigest);
      const gate = extra ? rebuilt(basePlanApprovals, [...baseRequestApprovals, extra]) : inner;
      return gate.approveRequestProposal(proposal, document, context);
    },
  } satisfies Authority & RequestApprovalAuthority);
}

/**
 * Atomic, owner-only approval artifact store for one owner approval directory.
 *
 * `write` is the only place in the application layer that creates an approval document, and it is reachable
 * only from the entry port after it consumed a human-confirmation capability. A file that already exists is
 * never overwritten: identical bytes are reused, anything else is refused with `ENTRY_APPROVAL_CONFLICT`.
 */
export function createOwnerApprovalPort(options: { directory: string; now?: () => number }): EntryApprovalPort {
  const directory = options.directory;
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    entryFail('ENTRY_INTEGRATION_REQUIRED', 'the owner approval directory must be a canonical absolute path');
  }
  const clock = options.now ?? Date.now;

  const documentFor = (request: EntryApprovalMintRequest): { path: string; bytes: string } => {
    if (request.approvalRef.length === 0 || request.approvalRef.length > 500) entryFail('ENTRY_FAILED', 'an approval reference must be bounded');
    const approvedAt = request.approvedAt;
    if (!(Date.parse(approvedAt) <= clock() + 1000) || !(Date.parse(request.expiresAt) > Date.parse(approvedAt))) {
      entryFail('ENTRY_APPROVAL_WINDOW', 'the minted approval window must start at or before now and end after it starts');
    }
    const approvalId = `human-${request.proposalDigest.slice(0, 32)}`;
    const note = 'Created by the interactive /p2o command after an explicit human confirmation of this exact sealed proposal; verified by the owner ledger.';
    if (request.kind === 'request') {
      const document = {
        version: 1 as const, approvalId, proposalId: request.proposalId, proposalDigest: request.proposalDigest,
        runId: request.runId, approvedBy: 'human:/p2o confirmation', reference: request.approvalRef,
        approvedAt, expiresAt: request.expiresAt, requestCount: request.requestCount ?? 0, note,
      };
      const parsed = planRequestApprovalDocumentSchema.parse(document);
      return { path: entryOwnerApprovalPath(directory, 'request', request.proposalDigest), bytes: `${JSON.stringify(parsed, null, 2)}\n` };
    }
    const document = {
      version: 1 as const, approvalId, proposalId: request.proposalId, proposalDigest: request.proposalDigest,
      runId: request.runId, approvedBy: 'human:/p2o confirmation', reference: request.approvalRef,
      approvedAt, expiresAt: request.expiresAt, taskCount: request.taskCount ?? 0, observationCount: request.observationCount ?? 0, note,
    };
    const parsed = planApprovalDocumentSchema.parse(document);
    return { path: entryOwnerApprovalPath(directory, 'plan', request.proposalDigest), bytes: `${JSON.stringify(parsed, null, 2)}\n` };
  };

  return Object.freeze({
    async exists(kind: EntryOwnerApprovalKind, proposalDigest: string): Promise<boolean> {
      return present(entryOwnerApprovalPath(directory, kind, proposalDigest));
    },

    async write(request: EntryApprovalMintRequest): Promise<{ path: string; reused: boolean }> {
      const { path, bytes } = documentFor(request);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        writeFileSync(path, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        return { path, reused: false };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      // An owner-authored document already exists: re-validate it as a canonical owner-only file and reuse
      // it only when it is byte-identical. A different document is never overwritten or silently replaced.
      const existing = readFileSync(path, 'utf8');
      readOwnerDocument(path, 'owner approval artifact');
      if (existing === bytes) return { path, reused: true };
      entryFail('ENTRY_APPROVAL_CONFLICT',
        `an owner approval artifact already exists for this exact proposal digest (${path}) and differs from the confirmed one; entry never overwrites an owner document`);
    },
  } satisfies EntryApprovalPort);
}

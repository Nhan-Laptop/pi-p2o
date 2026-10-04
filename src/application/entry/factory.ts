/**
 * Production factory for the target-entry workflow.
 *
 * The factory reads the owner-approved `RunManifest` document, derives the owner-approved target list, wires
 * the execution adapters that the composition actually supplies and returns a `TargetEntryPort`. Missing
 * wiring is never silently substituted: without a model plan author the port refuses `plan` with
 * `ENTRY_PLAN_AUTHOR_REQUIRED`, and without generated/owner-menu execution wiring the corresponding plan
 * flavour is refused with an explicit unsupported code (see docs/architecture/target-entry.md for the exact
 * composition hand-off).
 */
import { runSchema, type RunManifest, type RuntimeSelection } from '../../contracts/index.js';
import type { PlanRequestEnvelope } from '../../contracts/plan-request.js';
import type { ControlBackend } from '../../interface/types.js';
import type { TargetEntryPort } from '../../interface/target-entry.js';
import type { Role } from '../../orchestrator/index.js';
import { createOwnerApprovalPort, ownerDocumentPathFor as ownerPathProvider } from './approvals.js';
import { readOwnerDocument } from './documents.js';
import { entryFail } from './errors.js';
import {
  createGeneratedRequestExecution, createOwnerMenuExecution,
  type EntryOwnerDocumentPath, type GeneratedRequestExecutionOptions, type OwnerMenuExecutionOptions,
} from './executions.js';
import { createTargetEntryPort, ensureEntryWorkspace } from './port.js';
import type {
  EntryBounds, EntryCommandRunner, EntryObserver, EntryOwnerObservation, EntryPlanAuthor, EntryPlanExecution,
  EntryRunBinding, TargetEntryOptions,
} from './types.js';
export interface EntryRunBindingOptions {
  backend: ControlBackend;
  /** Canonical absolute path of the owner-approved RunManifest document. */
  manifestPath: string;
  mode: 'fixture' | 'assessment';
  /** Owner-approved observation menu (`ApplicationConfig.checks`), mapped by the composition. */
  ownerObservations?: EntryOwnerObservation[];
  /** Controller-derived owner envelope for generated HTTP requests. */
  requestEnvelope?: PlanRequestEnvelope;
  selection?: RuntimeSelection;
}

/** Read + validate the owner run document and derive the owner-approved target list. Never mints authority. */
export async function readEntryRunBinding(options: EntryRunBindingOptions): Promise<EntryRunBinding> {
  const parsed = readOwnerDocument(options.manifestPath, 'P2O entry run manifest');
  const run = runSchema.parse(parsed) as RunManifest;
  const envelope = options.requestEnvelope;
  const accounts = envelope ? [...envelope.accounts] : [];
  return {
    backend: options.backend,
    manifestPath: options.manifestPath,
    mode: options.mode,
    run,
    approvedTargets: run.authorization.targets.map(target => ({
      targetId: target.id,
      kind: target.kind,
      locator: target.locator,
      ...(target.digest ? { digest: target.digest } : {}),
      ...(target.revision ? { revision: target.revision } : {}),
      actions: [...run.authorization.allowedActions],
      accounts,
    })),
    ownerObservations: options.ownerObservations ?? [],
    ...(envelope ? { requestEnvelope: envelope } : {}),
    ...(options.selection ? { selection: options.selection } : {}),
  };
}

/** Generated-request execution wiring; the ledger and the envelope are required, approval stays owner-side. */
export interface EntryGeneratedWiring {
  ledger: GeneratedRequestExecutionOptions['ledger'];
  /** Owner-authored approval path; defaults to `approvalDirectory` when that is configured. */
  ownerDocumentPath?: EntryOwnerDocumentPath;
  register: GeneratedRequestExecutionOptions['register'];
  taskFor?: GeneratedRequestExecutionOptions['taskFor'];
}

/** Owner-menu execution wiring; approval and workspace resolution stay composition/owner-side. */
export interface EntryOwnerMenuWiring {
  ledger: OwnerMenuExecutionOptions['ledger'];
  /** Owner-authored approval path; defaults to `approvalDirectory` when that is configured. */
  ownerDocumentPath?: EntryOwnerDocumentPath;
  register: OwnerMenuExecutionOptions['register'];
  workspaceFor: OwnerMenuExecutionOptions['workspaceFor'];
  role?: Role;
}

export interface ApplicationEntryOptions {
  backend: ControlBackend;
  manifestPath: string;
  mode: 'fixture' | 'assessment';
  /** Canonical absolute private root for snapshots, clones and plan records. */
  workspaceRoot: string;
  /**
   * Owner-controlled approval directory. When set, the port may mint the exact approval artifact for a
   * sealed proposal from a consumed human confirmation, and the two owner-document paths default here.
   */
  approvalDirectory?: string;
  /** Lifetime of a controller-minted approval; clamped to the owner authorization window and deadline. */
  approvalTtlMs?: number;
  /** Pi session working directory used to resolve relative local targets. */
  cwd: string;
  ownerObservations?: EntryOwnerObservation[];
  requestEnvelope?: PlanRequestEnvelope;
  /** Model-authored plan seam (Pi/planner runtime). Absent makes `plan` fail explicitly. */
  planAuthor?: EntryPlanAuthor;
  /** Composition-owned owner-menu selection expansion; absent refuses the selection flavour. */
  buildOwnerMenuProposal?: TargetEntryOptions['buildOwnerMenuProposal'];
  generated?: EntryGeneratedWiring;
  ownerMenu?: EntryOwnerMenuWiring;
  selection?: RuntimeSelection;
  bounds?: Partial<EntryBounds>;
  clock?: () => number;
  newId?: () => string;
  gitBinary?: string;
  commandRunner?: EntryCommandRunner;
  observer?: EntryObserver;
}

/**
 * Build the production entry port. Construction validates the owner document and the private workspace; it
 * never touches the target and never launches anything.
 */
export async function createApplicationEntryPort(options: ApplicationEntryOptions): Promise<TargetEntryPort> {
  if (!options.workspaceRoot.startsWith('/') || options.workspaceRoot.length < 2) {
    entryFail('ENTRY_INTEGRATION_REQUIRED', 'entry workspace root must be a canonical absolute path');
  }
  await ensureEntryWorkspace(options.workspaceRoot);
  const now = options.clock ?? Date.now;
  const binding = await readEntryRunBinding({
    backend: options.backend,
    manifestPath: options.manifestPath,
    mode: options.mode,
    ...(options.ownerObservations ? { ownerObservations: options.ownerObservations } : {}),
    ...(options.requestEnvelope ? { requestEnvelope: options.requestEnvelope } : {}),
    ...(options.selection ? { selection: options.selection } : {}),
  });
  const approvalDirectory = options.approvalDirectory;
  const approvals = approvalDirectory ? createOwnerApprovalPort({ directory: approvalDirectory, now }) : undefined;
  const ownerDocumentPathFor = (kind: 'plan' | 'request', explicit: EntryOwnerDocumentPath | undefined): EntryOwnerDocumentPath => {
    if (explicit) return explicit;
    if (approvalDirectory) return ownerPathProvider(approvalDirectory, kind);
    entryFail('ENTRY_INTEGRATION_REQUIRED',
      `the ${kind} plan flavour needs an owner approval directory (or an explicit ownerDocumentPath) so its artifact can be read and verified`);
  };
  const executions: TargetEntryOptions['executions'] = {};
  if (options.generated) {
    if (!options.requestEnvelope) {
      entryFail('ENTRY_INTEGRATION_REQUIRED',
        'generated-request execution requires the controller-derived owner request envelope; pass requestEnvelope with the generated ledger');
    }
    executions['generated-requests'] = createGeneratedRequestExecution({
      ledger: options.generated.ledger,
      run: binding.run,
      envelope: options.requestEnvelope,
      ownerDocumentPath: ownerDocumentPathFor('request', options.generated.ownerDocumentPath),
      register: options.generated.register,
      ...(options.generated.taskFor ? { taskFor: options.generated.taskFor } : {}),
      ...(options.selection ? { selection: options.selection } : {}),
      now,
    });
  }
  const ownerMenuDocumentPath = options.ownerMenu ? ownerDocumentPathFor('plan', options.ownerMenu.ownerDocumentPath) : undefined;
  if (options.ownerMenu) {
    executions['owner-menu'] = createOwnerMenuExecution({
      ledger: options.ownerMenu.ledger,
      run: binding.run,
      ownerDocumentPath: ownerMenuDocumentPath,
      register: options.ownerMenu.register,
      workspaceFor: options.ownerMenu.workspaceFor,
      ...(options.ownerMenu.role ? { role: options.ownerMenu.role } : {}),
      ...(options.selection ? { selection: options.selection } : {}),
      now,
    });
  }
  return createTargetEntryPort({
    binding,
    workspaceRoot: options.workspaceRoot,
    cwd: options.cwd,
    ...(options.planAuthor ? { planAuthor: options.planAuthor } : {}),
    ...(options.buildOwnerMenuProposal ? { buildOwnerMenuProposal: options.buildOwnerMenuProposal } : {}),
    executions,
    ...(approvals ? { approvals } : {}),
    ...(options.approvalTtlMs === undefined ? {} : { approvalTtlMs: options.approvalTtlMs }),
    ...(options.bounds ? { bounds: options.bounds } : {}),
    clock: now,
    ...(options.newId ? { newId: options.newId } : {}),
    ...(options.gitBinary ? { gitBinary: options.gitBinary } : {}),
    ...(options.commandRunner ? { commandRunner: options.commandRunner } : {}),
    ...(options.observer ? { observer: options.observer } : {}),
  });
}

/** Owner-document-derived seams; `createP2OBackend` adds the composed backend, cwd and model author. */
export type EntrySeams = Omit<ApplicationEntryOptions, 'backend' | 'cwd' | 'planAuthor'>;

/** Explicit marker for compositions that cannot bind an owner document: the factory refuses to fabricate one. */
export function entryIntegrationRequired(detail: string): never {
  entryFail('ENTRY_INTEGRATION_REQUIRED', detail);
}

export type { EntryPlanExecution };

/**
 * Target-entry workflow (`/p2o --target …`).
 *
 * The interface-frozen port lives in `src/interface/target-entry.ts`; this directory implements it and owns
 * every entry-side seam the composition can inject.
 */
export { EntryError, type EntryFailureCode } from './errors.js';
export {
  ENTRY_BOUNDS_DEFAULTS,
  type EntryAcquisition, type EntryApprovalMintRequest, type EntryApprovalPort, type EntryApprovedTarget, type EntryBounds, type EntryCommandResult,
  type EntryCommandRunner, type EntryDelegationInput, type EntryDelegationPort, type EntryDelegationPreflight,
  type EntryObserver, type EntryOwnerObservation, type EntryPlanAuthor, type EntryPlanAuthorInput,
  type EntryPlanAuthorOutput, type EntryPlanExecution, type EntryPlanExecutionCompleteInput,
  type EntryPlanExecutionCompletion, type EntryPlanExecutionProposeInput, type EntryPlanFacts, type EntryPlanPacket,
  type EntryPlanStore, type EntryRunBinding, type EntryTechnique, type StoredEntryPlan, type TargetEntryOptions,
} from './types.js';
export { ENTRY_TECHNIQUE_ROUTES, skillsFor, type EntryTechniqueRoute } from './techniques.js';
export {
  canonicalLocalRoot, isLoopbackHost, normalizeGitHubRepo, resolveEntryTarget,
  type ResolvedEntryTarget,
} from './targets.js';
export { isExcludedRelativePath, createReadOnlySnapshot, fingerprintTree, type EntryTreeFingerprint } from './snapshot.js';
export {
  buildGitCloneInvocation, cloneGitHubRepoSafely, createProcessRunner, privateDestination,
  type CloneResult, type GitCloneInvocation,
} from './clone.js';
export { createEntryPlanStore } from './plans.js';
export { readOwnerDocument, ensureOwnerRunManifest, MAX_OWNER_DOCUMENT_BYTES } from './documents.js';
export { planFactsFor, sealPlanDigest, validatePlanAuthorOutput, ENTRY_PLAN_LIMITS } from './authoring.js';
export { createPiModelPlanAuthor, planAuthorPrompt, extractPlanJson, failForEmptyPlanCompletion, MAX_AUTHOR_RESPONSE_CHARS, type PiPlanAuthorOptions, type PiPlanAuthorCompletion, type PiPlanAuthorCompletionResult } from './pi-author.js';
export {
  createOwnerDirectoryAuthority, createOwnerApprovalPort, entryOwnerApprovalPath, ownerDocumentPathFor, type EntryOwnerApprovalKind,
} from './approvals.js';
export {
  createGeneratedRequestExecution, createOwnerMenuExecution,
  type GeneratedRequestExecutionOptions, type OwnerMenuExecutionOptions,
} from './executions.js';
export { createBackendDelegation, type BackendDelegationOptions } from './delegation.js';
export { createTargetEntryPort, ensureEntryWorkspace } from './port.js';
export {
  createApplicationEntryPort, readEntryRunBinding, entryIntegrationRequired,
  type ApplicationEntryOptions, type EntryGeneratedWiring, type EntryOwnerMenuWiring, type EntryRunBindingOptions, type EntrySeams,
} from './factory.js';

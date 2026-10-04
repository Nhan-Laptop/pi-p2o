import { dirname, join, resolve, sep } from 'node:path';
import { digestJson, canonicalJson, type ArtifactReference, type Scope } from '../../contracts/index.js';
import { createContainerSandbox, type ContainerSandboxOptions, type SourceContainerSandbox } from '../../tools/container.js';
import { deepFreeze } from '../../policy/validation.js';
import type { PreflightReport } from '../../tools/types.js';
import { assertSnapshotSeal, ensurePrivateSourceDirectory } from '../entry/snapshot.js';
import { entryFail, safeText } from '../entry/errors.js';
import { captureContainerLifecycle } from './container-lifecycle.js';
import { assertIssuedSourceSnapshot, copySourceRequest } from './acquire.js';
import { assertSourceIdentity, type ApprovedSourceRequest, type ApprovedSourceSnapshot, type SourceOwnerGate } from './identity.js';

export type QualifiedSourceContainerSettings = Omit<ContainerSandboxOptions, 'inputRoot' | 'outputRoot' | 'trustedInputSnapshot' | 'approvedSource' | 'runner' | 'fixtureAcknowledgement'>;
export interface SourceEvidenceFingerprints {
  readonly environmentId: string;
  /** Exact value the broker puts in ToolReceipt.configurationDigest. NOT an owner-root digest. */
  readonly configurationDigest: string;
  readonly inputDigests: readonly string[];
  readonly inputs: readonly ArtifactReference[];
  readonly inputRevision: string;
  readonly sourceIdentityDigest: string;
  /** Human scope binding, distinct from the broker policy.scope digest. */
  readonly approvedScopeDigest: string;
}
export interface ApprovedSourceContainerBinding {
  readonly source: ApprovedSourceSnapshot;
  readonly sandbox: SourceContainerSandbox;
  readonly inputRoot: string;
  readonly outputRoot: string;
  readonly fingerprints: SourceEvidenceFingerprints;
  readonly preflight: PreflightReport;
  /** Controller document, not a collector receipt. Admit using the existing collector bridge. */
  readonly evidenceDocument: Readonly<Record<string, unknown>>;
  assertCurrent(signal?: AbortSignal): Promise<void>;
  /** Fail before dispatch if tasks/collectors still refer to the old owner-root configuration. */
  assertEvidenceScope(scope: Pick<Scope, 'environmentId' | 'configurationDigest' | 'inputs'>): void;
}
/** No pull/build/re-pin/fallback. Consumes only a controller-issued approved immutable source tree. */
export async function bindApprovedSourceContainer(options: {
  request: ApprovedSourceRequest;
  source: ApprovedSourceSnapshot;
  authorize: SourceOwnerGate;
  /** Current owner-qualified engine/image/layer/base/worker/seccomp pins; never inferred or repaired. */
  qualified: QualifiedSourceContainerSettings;
  outputRoot?: string;
  signal?: AbortSignal;
}): Promise<ApprovedSourceContainerBinding> {
  const engine = options.qualified as ContainerSandboxOptions | undefined;
  if (engine?.runner || engine?.fixtureAcknowledgement) entryFail('ENTRY_SOURCE_UNBOUND', 'approved source binding requires the actual qualified engine, never injected/container-fixture evidence');
  const lifecycle = captureContainerLifecycle(options.qualified?.lifecycle), controllerLifecycle = captureContainerLifecycle(options.qualified?.controllerLifecycle);
  options = { ...options, ...(options.qualified ? { qualified: Object.freeze({ ...deepFreeze(structuredClone({ ...options.qualified, lifecycle: undefined, controllerLifecycle: undefined })), lifecycle, controllerLifecycle }) } : {}) };
  const request = copySourceRequest(options.request), source = options.source;
  assertIssuedSourceSnapshot(source);
  assertSourceIdentity(request, source);
  if (lifecycle && lifecycle.scope.runId !== source.identity.runId) entryFail('ENTRY_SOURCE_UNBOUND', 'container lifecycle belongs to another approved source run');
  if (typeof options.authorize !== 'function') entryFail('ENTRY_HUMAN_APPROVAL_REQUIRED', 'the source container needs the existing owner-ledger gate');
  await options.authorize(request);
  assertSourceIdentity(request, source);
  await assertSnapshotSeal(source.seal, options.signal);
  if (!options.qualified?.qualification) entryFail('ENTRY_SOURCE_UNBOUND', 'current dedicated-lab container qualification is missing; no pull, re-pin or local fallback');
  const outputRoot = options.outputRoot ?? join(dirname(source.seal.root), 'outputs');
  const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
  if (outputRoot === sep || resolve(outputRoot) !== outputRoot || overlaps(outputRoot, source.seal.root) || (source.identity.kind === 'local-dir' && overlaps(outputRoot, source.identity.origin))) entryFail('TARGET_DENIED', 'writable outputs must be canonical and disjoint from both approved original and immutable input');
  await ensurePrivateSourceDirectory(outputRoot);
  const sandbox = createContainerSandbox({ ...options.qualified, inputRoot: source.seal.root, outputRoot, trustedInputSnapshot: true, approvedSource: { identityDigest: source.identityDigest, snapshot: source.seal } });
  const preflight = await sandbox.preflight(options.signal);
  if (!preflight.ok) entryFail('ENTRY_SOURCE_UNBOUND', `qualified source container is unavailable: ${safeText(preflight.checks.filter(check => !check.ok).map(check => check.detail).join('; '), 800)}; no pull, re-pin or local fallback`);
  const revision = source.identity.revision ?? source.identity.digest;
  const input: ArtifactReference = { id: `source-${source.identity.targetId}`, digest: source.identity.digest, locator: source.seal.root, revision };
  const fingerprints: SourceEvidenceFingerprints = deepFreeze({
    environmentId: `source-container-${digestJson({ identity: source.identityDigest, configuration: sandbox.configurationDigest }).slice(0, 32)}`,
    configurationDigest: sandbox.configurationDigest, inputDigests: [source.identity.digest], inputs: [input], inputRevision: revision,
    sourceIdentityDigest: source.identityDigest, approvedScopeDigest: source.identity.scopeDigest,
  });
  const assertCurrent = async (signal?: AbortSignal): Promise<void> => { assertSourceIdentity(request, source); await options.authorize(request); assertSourceIdentity(request, source); await assertSnapshotSeal(source.seal, signal); };
  return Object.freeze({
    source, sandbox, inputRoot: source.seal.root, outputRoot, fingerprints, preflight,
    evidenceDocument: deepFreeze({ version: 1, kind: 'approved-source-container-binding', source: source.identity, sourceIdentityDigest: source.identityDigest, inputRoot: source.seal.root, treeIdentity: source.seal.treeIdentity, fingerprints, boundary: sandbox.boundary, qualified: preflight, method: 'current-pinned-pack-mounted-file-hash-and-existing-lexical-analyzer', limits: ['Dedicated container shares the host kernel; not hostile-code isolation.', 'Controller snapshot guards detect drift, not malicious same-uid openat2 races.', 'Current pack source byte reader is bounded to 1 MiB per selected UTF-8 file.', 'No source install/build/hooks/submodules/scripts were executed.'] }),
    assertCurrent,
    assertEvidenceScope(scope: Pick<Scope, 'environmentId' | 'configurationDigest' | 'inputs'>) {
      if (scope.environmentId !== fingerprints.environmentId || scope.configurationDigest !== sandbox.configurationDigest || canonicalJson(scope.inputs) !== canonicalJson(fingerprints.inputs)) entryFail('ENTRY_SOURCE_UNBOUND', 'task/collector source environment, configuration or input fingerprints do not match the actual acquired container mount');
    },
  });
}

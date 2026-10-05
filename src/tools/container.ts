import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { checkCancelled, invariant, PolicyError } from '../policy/errors.js';
import { digest, deepFreeze, text, timestamp } from '../policy/validation.js';
import { isForbiddenAddress, isLoopback } from '../policy/network.js';
import { SandboxFilesystem, validateRelativePath, type FilesystemOptions } from './filesystem.js';
import { runFixedProcess, type FixedProcessResult } from './process.js';
import { sha256 } from './redaction.js';
import type { ExecutionSandbox } from './sandbox.js';
import type { PreflightReport, SourceEvidence, SourceFile } from './types.js';

import type { SessionScope } from '../runtime/types.js';
import { ContainerResourceManager, captureContainerLifecycle, type ContainerLifecycleBinding } from '../application/source-binding/container-lifecycle.js';
export { recoverContainerResources, containerSessionLabels, type ContainerLifecycleBinding, type ContainerRecoveryOptions } from '../application/source-binding/container-lifecycle.js';
import { assertSnapshotSeal, type EntrySnapshotSeal } from '../application/entry/snapshot.js';
export type EngineRunner = (executable: string, args: readonly string[], options: { input?: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }) => Promise<FixedProcessResult>;
export interface ContainerSandboxOptions extends FilesystemOptions {
  enginePath: '/usr/bin/docker' | '/usr/local/bin/docker';
  /** Client AND server must match this exact qualified release. */
  engineVersion: string;
  /**
   * Pinned local image identity. Either a registry `name@sha256:<64 hex>` digest or the
   * content-addressed local image ID `sha256:<64 hex>` produced by an unpushed `docker build`
   * (a local build has no RepoDigests). The adapter never pulls.
   */
  image: string;
  /**
   * Mandatory content pin for the pinned image: its exact `RootFS.Layers` diff ids as recorded by
   * `containers/prepare.mjs` in `image.rootfsLayers`. The image ID and the pack labels are metadata a
   * rebuilt or forged image can reproduce; layer diff ids are content addresses of the pack bytes.
   * The adapter refuses to start a container when this pin is absent or does not match.
   */
  imageRootfsLayers?: readonly string[];
  /**
   * Expected local image ID (`sha256:<64 hex>`) of the digest-pinned base resolved from the pack's
   * `org.pi-p2o.base.image` label, recorded as `base.localBaseImageId`. When absent the base binding
   * is still resolved and prefix-verified locally, but the exact recorded base build is not pinned.
   */
  baseImageId?: string;
  workerSha256: string;
  sourceSha256: string;
  seccompPath: string;
  seccompSha256: string;
  qualification: {
    acknowledgement: 'containers-share-host-kernel-not-hostile-code-isolation';
    dedicatedLab: true;
    approvedBy: string;
    expiresAt: string;
    nativeEnabled: boolean;
  };
  /** Trusted supervisor test/engine boundary only; never a worker-supplied callback. */
  /** Controller-approved immutable source view. The original owner root is never mounted. */
  approvedSource?: { identityDigest: string; snapshot: EntrySnapshotSeal };
  /** Explicit per-attempt registry binding; source invocations have no ambient ToolContext. */
  lifecycle?: ContainerLifecycleBinding;
  /** SEPARATE controller lease for preflight probes; never attributed to a worker attempt. */
  controllerLifecycle?: ContainerLifecycleBinding;
  runner?: EngineRunner;
  fixtureAcknowledgement?: 'inert-engine-fixture-not-container-isolation';
  /**
   * Bounded bring-up budget for sandbox readiness (engine/image inspection and the probe container run
   * that cold-starts the pinned pack). It is NOT the operation deadline: steady-state tool work keeps the
   * fixed per-CLI cap below, and the broker's operation timer only starts once preflight reports ready.
   * Defaults to 30_000 ms; never unbounded, never a fallback to an unsandboxed path.
   */
  startupBudgetMs?: number;
}

const PACK_VERSION = '1.0.0';
const DEFAULT_STARTUP_BUDGET_MS = 30_000;
/** Steady-state engine CLI cap for real work; the broker's operation timer is the outer bound. */
const OPERATION_CLI_TIMEOUT_MS = 15_000;
/** Termination proofs stay short: a killed CLI is never treated as termination. */
const TERMINATION_CLI_TIMEOUT_MS = 1_000;
const NODE_VERSION = 'v22.14.0';
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPO_DIGEST_PATTERN = /^[\w./:-]+@sha256:[a-f0-9]{64}$/;
/** Limits declared in runArgs and re-verified from the kernel inside the container. */
const REQUIRED_LIMITS = Object.freeze({ memoryMax: '268435456', pidsMax: '32', cpuQuota: '50000', cpuPeriod: '100000', nofile: '64', core: '0' });
const hash = (v: string) => invariant(/^[a-f0-9]{64}$/.test(v), 'INVALID_INPUT', 'Expected SHA-256 digest');
const escapeRegExp = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Docker 28 CLI/daemon wording for an absent container; anything else is NOT absence. */
const containerAbsent = (result: FixedProcessResult, name: string) => result.code === 1 && new RegExp(`^(?:Error: No such object: |Error response from daemon: No such (?:container|object): )${escapeRegExp(name)}$`).test(result.stderr.trim());
const record = (v: unknown): Record<string, unknown> => {
  invariant(v !== null && typeof v === 'object' && !Array.isArray(v), 'UNAVAILABLE', 'Pack evidence was not a JSON object');
  return v as Record<string, unknown>;
};
const flag = (evidence: Record<string, unknown>, key: string) => invariant(evidence[key] === true, 'UNAVAILABLE', `Pack constraint not satisfied: ${key}`);
const objectAt = (parent: Record<string, unknown>, key: string, message: string): Record<string, unknown> => {
  const value = parent[key];
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'UNAVAILABLE', message);
  return value as Record<string, unknown>;
};
const isLayerId = (value: unknown): value is string => typeof value === 'string' && IMAGE_ID_PATTERN.test(value);
/** Shape-validates the optional layer pin; `preflight` fails closed when the pin is absent. */
function validateLayerPin(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  invariant(Array.isArray(value) && value.length >= 1 && value.length <= 1024, 'INVALID_INPUT', 'imageRootfsLayers must be a non-empty bounded list of sha256 layer diff ids');
  for (const layer of value) invariant(isLayerId(layer), 'INVALID_INPUT', 'imageRootfsLayers must contain only sha256 layer diff ids');
  return Object.freeze([...value]);
}

export interface MountedSourceReadProof {
  readonly path: string; readonly sha256: string; readonly bytes: number;
  readonly sourceIdentityDigest: string; readonly inputTreeDigest: string;
  readonly method: 'pinned-pack-mounted-file-sha256';
}
export interface SourceContainerSandbox extends ExecutionSandbox {
  /** Controller observation only; source tool still exposes the existing SourceEvidence schema. */
  verifyMountedSource(path: string, signal?: AbortSignal): Promise<MountedSourceReadProof>;
  readonly sessions: number;
  releaseAttempt(scope: SessionScope): Promise<number>;
  outstanding(scope: SessionScope): number;
  close(): Promise<void>;
}
export function createContainerSandbox(settings: ContainerSandboxOptions): SourceContainerSandbox {
  const lifecycle = captureContainerLifecycle(settings.lifecycle), controllerLifecycle = captureContainerLifecycle(settings.controllerLifecycle);
  invariant(!lifecycle || !controllerLifecycle || JSON.stringify(lifecycle.scope) !== JSON.stringify(controllerLifecycle.scope), 'UNAVAILABLE', 'Controller preflight and worker attempt must have distinct lifecycle scopes');
  const options: ContainerSandboxOptions = deepFreeze({ ...structuredClone({ ...settings, runner: undefined, lifecycle: undefined, controllerLifecycle: undefined }), runner: settings.runner });
  invariant(['/usr/bin/docker', '/usr/local/bin/docker'].includes(options.enginePath), 'INVALID_INPUT', 'Unapproved engine path');
  text(options.engineVersion, 'engineVersion', 64);
  const imagePin = IMAGE_ID_PATTERN.test(options.image) ? 'local-image-id' : REPO_DIGEST_PATTERN.test(options.image) ? 'repo-digest' : undefined;
  invariant(imagePin, 'INVALID_INPUT', 'A digest-pinned image (name@sha256:<64 hex> or local sha256:<64 hex> image ID) is required');
  const layerPin = validateLayerPin(options.imageRootfsLayers);
  invariant(options.baseImageId === undefined || IMAGE_ID_PATTERN.test(options.baseImageId), 'INVALID_INPUT', 'baseImageId must be a sha256 image ID');
  hash(options.workerSha256); hash(options.sourceSha256); hash(options.seccompSha256);
  invariant(isAbsolute(options.seccompPath) && !/[,:\n]/.test(options.seccompPath), 'INVALID_INPUT', 'Absolute pinned seccomp profile required');
  invariant(options.qualification?.acknowledgement === 'containers-share-host-kernel-not-hostile-code-isolation' && options.qualification.dedicatedLab === true && typeof options.qualification.nativeEnabled === 'boolean', 'UNAVAILABLE', 'Explicit dedicated-lab qualification required');
  invariant(options.startupBudgetMs === undefined || (Number.isSafeInteger(options.startupBudgetMs) && options.startupBudgetMs >= 1000 && options.startupBudgetMs <= 300_000), 'INVALID_INPUT', 'startupBudgetMs must be a bounded 1s..300s bring-up budget');
  const startupBudgetMs = options.startupBudgetMs ?? DEFAULT_STARTUP_BUDGET_MS;
  text(options.qualification.approvedBy, 'qualification.approvedBy'); timestamp(options.qualification.expiresAt, 'qualification.expiresAt');
  const filesystem = new SandboxFilesystem(options);
  invariant(!/[,:\n]/.test(filesystem.inputRoot), 'FILESYSTEM_DENIED', 'Input mount path contains engine separators');
  if (options.approvedSource) {
    hash(options.approvedSource.identityDigest);
    hash(options.approvedSource.snapshot.digest); hash(options.approvedSource.snapshot.treeIdentity);
    invariant(options.approvedSource.snapshot.root === filesystem.inputRoot && options.approvedSource.snapshot.containerReadable === true, 'IDENTITY_DENIED', 'Approved source snapshot must be the actual container-readable input mount');
  }
  const assertSource = async (signal?: AbortSignal): Promise<void> => {
    if (!options.approvedSource) return;
    try { await assertSnapshotSeal(options.approvedSource.snapshot, signal); }
    catch { checkCancelled(signal); throw new PolicyError('IDENTITY_DENIED', 'Approved immutable source snapshot changed or is unsafe; no source fallback'); }
  };
  const runner = options.runner ?? runFixedProcess;
  invariant(!options.runner || options.fixtureAcknowledgement === 'inert-engine-fixture-not-container-isolation', 'UNAVAILABLE', 'Injected engine runner requires explicit inert-fixture acknowledgement');
  const boundary = options.runner ? 'inert-engine-fixture:no-container-isolation-attestation:loopback-only' : 'dedicated-offline-container:shared-kernel:broker-only-target-egress';
  /**
   * The configuration digest attests the OWNER-APPROVED security-relevant sandbox configuration (pack image +
   * content layer pin, engine, seccomp, resource limits, filesystem roots, qualification) so evidence
   * admission can bind a receipt to the approved scope document.
   *
   * Run-scoped lifecycle bookkeeping is deliberately EXCLUDED. The durable create/start lifecycle binding
   * (`lifecycle`/`controllerLifecycle`) is allocated per run by the composition AFTER owner consent, so
   * folding it into this digest would make the runtime sandbox digest differ from the owner-approved scope
   * digest and no broker receipt could ever be admitted (`broker-input`). Lifecycle ownership is attested
   * separately by the runtime/guardian receipts and the exact container session labels, never by this digest.
   */
  const configurationDigest = digest({ ...options, runner: undefined, lifecycle: undefined, controllerLifecycle: undefined, mode: 'container', nodeVersion: NODE_VERSION, packVersion: PACK_VERSION, imagePin });
  let verifiedImageId: string | undefined;
  let ready = false;
  /** Last preflight failure, so callers receive the specific fail-closed code, not a generic denial. */
  let failure: PolicyError | undefined;
  const assertQualified = () => invariant(Date.now() < Date.parse(options.qualification.expiresAt), 'EXPIRED', 'Lab qualification expired');
  /** Re-raises the specific preflight refusal so callers can distinguish identity drift from unavailability. */
  const assertReady = () => { if (!ready) throw failure ?? new PolicyError('UNAVAILABLE', 'Container preflight failed or not performed'); };
  /**
   * Bring-up CLI calls (image/engine inspection, container create, the probe run) get the bounded startup
   * budget; steady-state operations keep the fixed 15s cap, and termination proofs stay at 1s. The probe run
   * is identified by its own request bytes, so no mutable phase flag can leak the longer budget into worker
   * traffic. `cleanup` always wins. A cold packed image therefore never fails inside the operation deadline.
   */
  const cliTimeoutMs = (args: readonly string[], input?: string, cleanup = false): number => {
    if (cleanup) return TERMINATION_CLI_TIMEOUT_MS;
    const verb = args[0];
    if (verb === 'create' || verb === 'inspect' || verb === 'version' || verb === 'image') return startupBudgetMs;
    if (verb === 'start' && typeof input === 'string' && input.includes('"operation":"preflight"')) return startupBudgetMs;
    return OPERATION_CLI_TIMEOUT_MS;
  };
  const engine = (args: readonly string[], input?: string, signal?: AbortSignal, cleanup = false) => runner(options.enginePath, args, { input, timeoutMs: cliTimeoutMs(args, input, cleanup), maxOutputBytes: 4194304, signal });

  function runArgs(name: string): string[] {
    return ['run', '--name', name, '--rm', '--pull=never', '--network=none', '--read-only', '--user=65532:65532', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', `--security-opt=seccomp=${options.seccompPath}`, '--pids-limit=32', '--memory=256m', '--memory-swap=256m', '--cpus=0.5', '--ulimit=nofile=64:64', '--ulimit=core=0:0', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=8388608,mode=1777', '--tmpfs=/outputs:rw,noexec,nosuid,nodev,size=8388608,mode=1777', '--mount', `type=bind,src=${filesystem.inputRoot},dst=/inputs,readonly,bind-propagation=rprivate`, '--env=HOME=/tmp', '--env=NODE_OPTIONS=', '--log-driver=none', '--entrypoint=/usr/local/bin/node', '-i', options.image, '/opt/p2o/offline-worker.mjs'];
  }

  /**
   * Termination proof. Killing the engine CLI does not prove container termination, and a
   * container can still be created by the daemon just after an aborted CLI exits, so removal
   * plus absence must be observed repeatedly, not once.
   */
  async function verifyTerminated(name: string, rounds = 4): Promise<boolean> {
    let absentStreak = 0;
    for (let round = 0; round < rounds; round++) {
      let absent = false;
      try {
        const removal = await engine(['rm', '--force', name], undefined, undefined, true);
        const inspection = await engine(['inspect', name], undefined, undefined, true);
        absent = (removal.code === 0 || containerAbsent(removal, name)) && containerAbsent(inspection, name);
      } catch { absent = false; }
      absentStreak = absent ? absentStreak + 1 : 0;
      if (absentStreak >= 2) return true;
      if (round < rounds - 1) await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  }

  const resources = new ContainerResourceManager({ engine, enginePath: options.enginePath, engineVersion: options.engineVersion, image: options.image, configurationDigest, runArgs, verifiedImageId: () => verifiedImageId, legacyTermination: verifyTerminated, lifecycle, controllerLifecycle });
  async function invoke(input: unknown, signal?: AbortSignal, preflight = false): Promise<unknown> {
    checkCancelled(signal); assertQualified();
    await assertSource(signal);
    const stat = await lstat(options.seccompPath);
    invariant(stat.isFile() && !stat.isSymbolicLink() && sha256(await readFile(options.seccompPath)) === options.seccompSha256, 'UNAVAILABLE', 'Pinned seccomp profile changed');
    let result: FixedProcessResult;
    try { result = await resources.invoke(input, signal, preflight); }
    catch (error) { ready = false; failure = error instanceof PolicyError ? error : new PolicyError('UNAVAILABLE', 'Container invocation/lifecycle failed; unresolved inventory must remain visible'); throw error; }
    await assertSource(signal);
    checkCancelled(signal);
    invariant(result?.code === 0, 'UNAVAILABLE', 'Qualified offline pack failed; no local fallback');
    try { return JSON.parse(result.stdout); } catch { throw new PolicyError('UNAVAILABLE', 'Pack did not return valid evidence JSON'); }
  }

  /**
   * Local image identity; never triggers a pull or a build. Verification chain: daemon-reported
   * image ID / RepoDigest -> declared pack labels and runtime config -> content-addressed rootfs
   * layer pin -> descent from the locally resolved digest-pinned base image layers. Tags, names and
   * label strings are metadata that a rebuilt or forged image can copy, so any mismatch (or any claim
   * that cannot be verified on this host) is an IDENTITY_DENIED refusal before a container is started.
   */
  async function inspectLocalImage(reference: string, code: 'UNAVAILABLE' | 'IDENTITY_DENIED', reason: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await engine(['image', 'inspect', '--format', '{{json .}}', reference], undefined, signal);
    invariant(result.code === 0, code, reason);
    try { return record(JSON.parse(result.stdout)); } catch { throw new PolicyError(code, reason); }
  }
  const layersOf = (source: Record<string, unknown>, code: 'UNAVAILABLE' | 'IDENTITY_DENIED', message: string): readonly string[] => {
    const rootfs = objectAt(source, 'RootFS', message);
    const raw = Array.isArray(rootfs.Layers) ? rootfs.Layers : [];
    const layers = raw.filter(isLayerId);
    invariant(layers.length >= 1 && layers.length === raw.length, code, message);
    return layers;
  };

  async function inspectImage(signal?: AbortSignal): Promise<{ id: string; baseImage: string; baseImageId: string; platform: string; rootfs: string; layers: number; baseLayers: number; layerPin: 'verified' }> {
    invariant(layerPin, 'IDENTITY_DENIED', 'A content-addressed image layer pin (imageRootfsLayers) is required: an image ID or label set alone cannot prove the pack bytes');
    const image = await inspectLocalImage(options.image, 'UNAVAILABLE', 'Pinned local image unavailable; implicit pull disabled', signal);
    const id = typeof image.Id === 'string' ? image.Id : '';
    const digests = Array.isArray(image.RepoDigests) ? image.RepoDigests.filter((d): d is string => typeof d === 'string') : [];
    invariant(imagePin === 'local-image-id' ? id === options.image : digests.includes(options.image), 'IDENTITY_DENIED', 'Pinned image identity does not match the local image; implicit pull disabled');
    const layers = layersOf(image, 'UNAVAILABLE', 'Pinned image does not expose content-addressed root filesystem layers');
    const rootfsDigest = digest(layers);
    invariant(rootfsDigest === digest(layerPin), 'IDENTITY_DENIED', 'Pinned image layer content does not match the recorded pack layer pin; no container started');
    invariant(image.Os === 'linux', 'UNAVAILABLE', 'Pinned image is not a Linux image');
    const config = objectAt(image, 'Config', 'Pinned image did not report its runtime configuration');
    invariant(config.User === '65532:65532', 'IDENTITY_DENIED', 'Pinned image does not declare the non-root pack user');
    invariant(config.WorkingDir === '/outputs', 'IDENTITY_DENIED', 'Pinned image does not declare the qualified /outputs working directory');
    const env = Array.isArray(config.Env) ? config.Env.filter((v): v is string => typeof v === 'string') : [];
    invariant(env.includes('P2O_OFFLINE_PACK=1'), 'IDENTITY_DENIED', 'Pinned image does not declare the offline pack marker environment');
    const labels = objectAt(config, 'Labels', 'Pinned image did not report pack labels');
    invariant(labels['org.pi-p2o.pack.version'] === PACK_VERSION && labels['org.pi-p2o.node.version'] === '22.14.0', 'IDENTITY_DENIED', 'Pinned image is not the qualified pack release');
    invariant(labels['org.pi-p2o.worker.sha256'] === options.workerSha256 && labels['org.pi-p2o.source.sha256'] === options.sourceSha256, 'IDENTITY_DENIED', 'Pinned image bytes do not match the pinned worker/source identities');
    const baseImage = typeof labels['org.pi-p2o.base.image'] === 'string' ? labels['org.pi-p2o.base.image'] as string : '';
    invariant(REPO_DIGEST_PATTERN.test(baseImage), 'IDENTITY_DENIED', 'Pinned image does not record a digest-pinned base image');
    // Resolve the claimed base by digest locally (`image inspect` never pulls) and bind the pack's
    // leading layers to it; this is the only offline chain from the pack to a content-addressed base.
    const base = await inspectLocalImage(baseImage, 'IDENTITY_DENIED', `Claimed pack base ${baseImage} is not present locally, so pack base identity cannot be verified (pull exactly that digest or re-run containers/prepare.mjs; the adapter never pulls)`);
    const baseImageId = typeof base.Id === 'string' ? base.Id : '';
    invariant(IMAGE_ID_PATTERN.test(baseImageId), 'IDENTITY_DENIED', 'Locally resolved pack base image did not report an image ID');
    invariant(options.baseImageId === undefined || baseImageId === options.baseImageId, 'IDENTITY_DENIED', 'Locally resolved pack base image ID does not match the recorded base image pin');
    invariant(base.Os === 'linux' && base.Architecture === image.Architecture, 'IDENTITY_DENIED', 'Locally resolved pack base image platform does not match the pack image');
    const baseLayers = layersOf(base, 'IDENTITY_DENIED', 'Locally resolved pack base image does not expose content-addressed layers');
    invariant(layers.length > baseLayers.length && baseLayers.every((layer, index) => layers[index] === layer), 'IDENTITY_DENIED', 'Pinned image does not descend from the claimed base image layers; pack base identity is not verifiable');
    return { id, baseImage, baseImageId, platform: `${String(image.Os)}/${String(image.Architecture)}`, rootfs: rootfsDigest, layers: layers.length, baseLayers: baseLayers.length, layerPin: 'verified' };
  }

  /** Re-verifies everything the pack reports about the kernel-enforced confinement. */
  function verifyPackEvidence(hello: unknown): { identity: string; constraints: string } {
    const evidence = record(hello);
    invariant(evidence.protocol === 1, 'UNAVAILABLE', 'Pack protocol mismatch');
    invariant(evidence.nodeVersion === NODE_VERSION && evidence.packVersion === PACK_VERSION, 'IDENTITY_DENIED', 'Pack Node/pack release mismatch');
    invariant(evidence.workerSha256 === options.workerSha256 && evidence.sourceSha256 === options.sourceSha256, 'IDENTITY_DENIED', 'Pack in-image byte identity mismatch');
    invariant(typeof evidence.nodeSha256 === 'string' && /^[a-f0-9]{64}$/.test(evidence.nodeSha256), 'IDENTITY_DENIED', 'Pack did not report a pinned Node runtime identity');
    invariant(evidence.uid === 65532 && evidence.gid === 65532, 'UNAVAILABLE', 'Pack is not running as the pinned non-root identity');
    flag(evidence, 'nonRoot'); flag(evidence, 'pid1');
    flag(evidence, 'rootReadOnly'); flag(evidence, 'rootWriteDenied');
    flag(evidence, 'inputReadOnly'); flag(evidence, 'inputWriteDenied');
    flag(evidence, 'scratchWritable'); flag(evidence, 'noNetwork');
    invariant(evidence.seccompMode === 2 && typeof evidence.seccompFilters === 'number' && evidence.seccompFilters >= 1, 'UNAVAILABLE', 'Seccomp filtering is not active in the pack');
    invariant(evidence.noNewPrivileges === 1, 'UNAVAILABLE', 'no_new_privs is not set in the pack');
    invariant(evidence.capabilities === '0'.repeat(16), 'UNAVAILABLE', 'Pack retains capabilities');
    const ulimits = record(evidence.ulimits);
    invariant(ulimits.nofile === REQUIRED_LIMITS.nofile && ulimits.core === REQUIRED_LIMITS.core, 'UNAVAILABLE', 'Pack ulimits do not match the qualified runtime');
    const cgroup = record(evidence.cgroup);
    invariant(cgroup.memoryMax === REQUIRED_LIMITS.memoryMax && cgroup.pidsMax === REQUIRED_LIMITS.pidsMax && cgroup.cpuQuota === REQUIRED_LIMITS.cpuQuota && cgroup.cpuPeriod === REQUIRED_LIMITS.cpuPeriod, 'UNAVAILABLE', 'Pack resource limits do not match the qualified runtime');
    return {
      identity: `node=${String(evidence.nodeVersion)} pack=${String(evidence.packVersion)} nodeSha256=${String(evidence.nodeSha256)} workerSha256=${String(evidence.workerSha256)} sourceSha256=${String(evidence.sourceSha256)} platform=${String(evidence.platform)}/${String(evidence.arch)}`,
      constraints: `uid=${String(evidence.uid)} gid=${String(evidence.gid)} pid1=true root=ro inputs=ro write-denied=root,inputs scratch=rw seccomp=${String(evidence.seccompMode)} filters=${String(evidence.seccompFilters)} no-new-privs=${String(evidence.noNewPrivileges)} caps=${String(evidence.capabilities)} net-sockets=denied pids=${String(cgroup.pidsMax)} memory=${String(cgroup.memoryMax)} cpu=${String(cgroup.cpuQuota)}/${String(cgroup.cpuPeriod)} nofile=${String(ulimits.nofile)} core=${String(ulimits.core)} cgroup=v${String(cgroup.version)}`,
    };
  }

  /**
    * Reuse the current pinned pack's mounted-file reader (its `native` protocol operation), not a
    * new analyzer/helper/image. This is an internal byte/hash read for source authority; it does
    * not enable the native.inspect tool, execute binaries, or grant native execution permission.
    * The current reader is bounded to 1 MiB. Larger source is refused, never analyzed from stdin only.
    */
  async function mountedSource(path: string, signal?: AbortSignal): Promise<{ file: SourceFile; proof: MountedSourceReadProof }> {
    assertReady(); assertQualified();
    invariant(options.approvedSource, 'IDENTITY_DENIED', 'Mounted source proof requires an approved immutable input binding');
    validateRelativePath(path); await assertSource(signal);
    const file = await filesystem.readInput(path, signal);
    invariant(Buffer.byteLength(file.text) <= 1048576 && sha256(Buffer.from(file.text, 'utf8')) === file.sha256 && !file.text.includes('\u0000'), 'FILESYSTEM_DENIED', 'Mounted source reader accepts only bounded exact UTF-8 text');
    const observed = record(await invoke({ operation: 'native', path, expectedSha256: file.sha256 }, signal));
    invariant(observed.kind === 'native' && observed.path === path && observed.sha256 === file.sha256 && observed.bytes === Buffer.byteLength(file.text), 'IDENTITY_DENIED', 'In-container source bytes differ from the approved mounted input');
    return { file, proof: deepFreeze({ path, sha256: file.sha256, bytes: Buffer.byteLength(file.text), sourceIdentityDigest: options.approvedSource.identityDigest, inputTreeDigest: options.approvedSource.snapshot.digest, method: 'pinned-pack-mounted-file-sha256' as const }) };
  }

  return Object.freeze({
    mode: 'container', boundary, configurationDigest, filesystem, nativeEnabled: options.qualification.nativeEnabled, codeExecution: 'none',
    get sessions() { return resources.sessions; },
    releaseAttempt: (scope: SessionScope) => resources.releaseAttempt(scope),
    outstanding: (scope: SessionScope) => resources.outstanding(scope),
    async close() { ready = false; await resources.close(); },
    async preflight(signal?: AbortSignal): Promise<PreflightReport> {
      ready = false;
      const checks: { name: string; ok: boolean; detail: string }[] = [];
      const fs = await filesystem.preflight(); checks.push(...fs.checks);
      try {
        assertQualified();
        checkCancelled(signal);
        await assertSource(signal);
        if (options.approvedSource) checks.push({ name: 'approved-source-mount', ok: true, detail: `identity=${options.approvedSource.identityDigest} input=${options.approvedSource.snapshot.digest} tree=${options.approvedSource.snapshot.treeIdentity} mount=/inputs:ro` });
        const version = await engine(['version', '--format', '{{.Client.Version}}/{{.Server.Version}}'], undefined, signal);
        invariant(version.code === 0 && version.stdout.trim() === `${options.engineVersion}/${options.engineVersion}`, 'UNAVAILABLE', 'Pinned engine release unavailable');
        checks.push({ name: 'engine-release', ok: true, detail: `client=server=${options.engineVersion} executable=${options.enginePath}` });
        const image = await inspectImage(signal);
        verifiedImageId = image.id;
        checks.push({ name: 'image-pin', ok: true, detail: `pin=${options.image} (${imagePin}) id=${image.id} platform=${image.platform} base=${image.baseImage} baseId=${image.baseImageId} baseLayers=${image.baseLayers} layers=${image.layers} rootfs=${image.rootfs} layer-pin=${image.layerPin} labels=verified` });
        invariant(fs.ok, 'UNAVAILABLE', 'Safe filesystem unavailable');
        const pack = verifyPackEvidence(await invoke({ operation: 'preflight' }, signal, true));
        if (controllerLifecycle) checks.push({ name: 'container-lifecycle', ok: true, detail: 'Controller-scoped preflight enrolled before daemon create; exact ID/labels persisted before start; repeated absence resolved; worker lease is separate' });
        checks.push({ name: 'pack-identity', ok: true, detail: pack.identity });
        checks.push({ name: 'execution-constraints', ok: true, detail: pack.constraints });
        checks.push({ name: 'termination-verified', ok: true, detail: 'Removal plus repeated absence verified for the probe container; killed CLI is never treated as termination' });
        checks.push({ name: 'offline-container', ok: true, detail: 'Pinned engine/image/worker/Node; non-root, offline, read-only root+inputs, enforced limits; no fallback' });
        ready = true;
        failure = undefined;
      } catch (error) {
        ready = false;
        failure = error instanceof PolicyError ? error : new PolicyError('UNAVAILABLE', 'Qualified pinned engine/image/security pack unavailable');
        checks.push({ name: 'offline-container', ok: false, detail: `code=${failure.code} ${failure.message}; no unsandboxed fallback; unresolved daemon resources remain attributable` });
      }
      return deepFreeze({ ok: ready, boundary, checks });
    },
    assertEgress(address: string) { assertReady(); assertQualified(); invariant(!isForbiddenAddress(address) && (!options.runner || isLoopback(address)), 'ADDRESS_DENIED', 'Target egress requires the qualified broker; injected fixtures are loopback-only'); },
    async verifyMountedSource(path: string, signal?: AbortSignal) { return (await mountedSource(path, signal)).proof; },
    async analyzeSource(files: readonly SourceFile[], contains?: string, signal?: AbortSignal) {
      assertReady();
      if (!options.approvedSource) return await invoke({ operation: 'source', files, contains }, signal) as SourceEvidence;
      invariant(files.length >= 1 && files.length <= 64 && new Set(files.map(f => f.path)).size === files.length, 'INVALID_INPUT', 'Source file count/uniqueness exceeded');
      // Freeze caller data BEFORE await. Supplied text is only accepted after the real mount read
      // proves equality to the current pack's hash. Never authorize source using stdin assertions.
      const requested = files.map(file => ({ ...file }));
      const verified: SourceFile[] = [];
      let total = 0;
      for (const requestedFile of requested) {
        const { file } = await mountedSource(requestedFile.path, signal);
        invariant(file.sha256 === requestedFile.sha256 && file.text === requestedFile.text, 'IDENTITY_DENIED', 'Caller source differs from the approved container input');
        total += Buffer.byteLength(file.text);
        invariant(total <= 4194304, 'OUTPUT_LIMIT', 'Mounted source total byte limit exceeded');
        verified.push(file);
      }
      const result = record(await invoke({ operation: 'source', files: verified, contains }, signal));
      invariant(result.kind === 'source' && Array.isArray(result.files) && result.files.length === verified.length, 'IDENTITY_DENIED', 'Pinned source analyzer returned a different file set');
      for (let i = 0; i < verified.length; i++) {
        const observed = record(result.files[i]), file = verified[i]!;
        invariant(observed.path === file.path && observed.sha256 === file.sha256 && observed.bytes === Buffer.byteLength(file.text), 'IDENTITY_DENIED', 'Pinned analyzer evidence differs from the mounted source proof');
      }
      return result as unknown as SourceEvidence;
    },
    async inspectNative(path: string, signal?: AbortSignal) {
      assertReady();
      invariant(options.qualification.nativeEnabled, 'UNAVAILABLE', 'Native pack not explicitly qualified');
      validateRelativePath(path);
      const input = await filesystem.readInput(path, signal);
      return invoke({ operation: 'native', path, expectedSha256: input.sha256 }, signal);
    },
  });
}

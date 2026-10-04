import { checkCancelled, invariant } from '../../policy/errors.js';
import { deepFreeze, digest, text, timestamp } from '../../policy/validation.js';

/**
 * External coverage-guided fuzzers and scanners (ffuf/nuclei/sqlmap/...) are NEVER installed, built or
 * run on the host by this repository. They may only run through an owner-injected runner that proves a
 * pinned lab-image identity, and the contract here fails closed before `run()` is ever called when that
 * identity is absent, unpinned, expired or mismatched. See `docs/architecture/fuzzing-pack.md` for the
 * pinned lab-image recipe and `docs/architecture/vm-boundary.md` for the runtime non-claim.
 */
export interface ExternalRunnerIdentity {
  readonly tool: string;
  readonly version: string;
  /** `name@sha256:<64 hex>`; mutable tags are refused. */
  readonly imageRef: string;
  readonly binarySha256: string;
  readonly seccompProfileSha256: string;
  /** `scope-only` means every connection traverses the broker egress proxy; `none` means no network at all. */
  readonly networkPolicy: 'none' | 'scope-only';
  readonly platform: string;
}
export interface ExternalRunnerPin extends ExternalRunnerIdentity {
  readonly approvedBy: string;
  readonly expiresAt: string;
}
export interface ExternalFuzzRequest {
  readonly templateId: string;
  readonly seed: string;
  readonly maxRequests: number;
}
export interface ExternalRunnerResult {
  readonly exitCode: number;
  readonly requestsMade: number;
  readonly durationMs: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly artifactDigest: string;
}
export interface ExternalFuzzRunner {
  /** `undefined` means the runner cannot prove what it is; the contract refuses it. */
  readonly identity: ExternalRunnerIdentity | undefined;
  run(request: ExternalFuzzRequest, signal?: AbortSignal): Promise<ExternalRunnerResult>;
}
export interface ExternalToolRunEvidence {
  readonly kind: 'external-tool-run';
  readonly tool: string;
  readonly version: string;
  readonly imageRef: string;
  readonly binarySha256: string;
  readonly seccompProfileSha256: string;
  readonly networkPolicy: 'none' | 'scope-only';
  readonly platform: string;
  readonly identityDigest: string;
  readonly exitCode: number;
  readonly requestsMade: number;
  readonly durationMs: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly artifactDigest: string;
  readonly isolation: string;
  readonly limits: readonly string[];
}

export const EXTERNAL_TOOL_LIMITS = Object.freeze([
  'No external fuzzer or scanner is installed by this repository; execution requires an owner-injected runner with a pinned lab-image identity.',
  'The runner is refused unless tool, version, image digest, binary digest, seccomp profile digest, network policy and platform all match an unexpired owner pin.',
  'Coverage-guided execution belongs in the pinned lab image, never on the host: this contract provides the refusal path, not a runtime.',
  'Requests made by an external tool are charged to the same target budget by the egress proxy when networkPolicy is scope-only.',
]);
const SHA256 = /^[a-f0-9]{64}$/;
const PINNED_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;

export function externalToolIdentityDigest(identity: ExternalRunnerIdentity): string {
  return digest({
    tool: identity.tool, version: identity.version, imageRef: identity.imageRef,
    binarySha256: identity.binarySha256, seccompProfileSha256: identity.seccompProfileSha256,
    networkPolicy: identity.networkPolicy, platform: identity.platform,
  });
}

/**
 * Fail-closed identity verification. Every failure is a hard error and no work is dispatched: an
 * absent runner, an unprovable runner, an absent/expired pin or any identity drift refuses execution.
 */
export function assertExternalRunnerQualified(runner: ExternalFuzzRunner | undefined, pins: readonly ExternalRunnerPin[] | undefined, now: () => number = Date.now): ExternalRunnerIdentity {
  invariant(runner && typeof runner.run === 'function', 'UNAVAILABLE', 'No external fuzzer runner is installed in this runtime; coverage-guided tools are refused rather than installed at run time');
  const identity = runner.identity;
  invariant(identity && typeof identity === 'object', 'UNAVAILABLE', 'External runner cannot prove its identity; execution is refused');
  invariant(Array.isArray(pins) && pins.length > 0, 'UNAVAILABLE', 'No pinned lab-image identity is qualified; external tool execution is refused');
  const pin = pins.find(candidate => candidate && candidate.tool === identity.tool);
  invariant(pin, 'IDENTITY_DENIED', `External tool ${identity.tool} has no pinned identity; fail-closed refusal`);
  const expiresAt = timestamp(pin.expiresAt, 'externalRunnerPin.expiresAt');
  invariant(now() < Date.parse(expiresAt), 'EXPIRED', 'External tool pin expired; re-approval is required before execution');
  for (const field of ['version', 'imageRef', 'binarySha256', 'seccompProfileSha256', 'networkPolicy', 'platform'] as const) {
    invariant(identity[field] === pin[field], 'IDENTITY_DENIED', `External tool ${identity.tool} ${field} does not match the pinned lab-image identity`);
  }
  invariant(PINNED_IMAGE.test(identity.imageRef), 'IDENTITY_DENIED', 'External tool image must be referenced by an @sha256 digest; mutable tags are refused');
  invariant(SHA256.test(identity.binarySha256) && SHA256.test(identity.seccompProfileSha256), 'IDENTITY_DENIED', 'External tool pin must carry sha256 identities for the binary and the seccomp profile');
  invariant(identity.networkPolicy === 'none' || identity.networkPolicy === 'scope-only', 'IDENTITY_DENIED', 'External runner network policy must be none or scope-only; host networking is refused');
  return Object.freeze({ ...identity });
}

export async function runExternalTool(options: {
  readonly runner?: ExternalFuzzRunner;
  readonly pins?: readonly ExternalRunnerPin[];
  readonly request: ExternalFuzzRequest;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<ExternalToolRunEvidence> {
  const now = options.now ?? Date.now;
  const identity = assertExternalRunnerQualified(options.runner, options.pins, now);
  checkCancelled(options.signal);
  const request = options.request;
  text(request.templateId, 'external.templateId', 128);
  invariant(Number.isSafeInteger(request.maxRequests) && request.maxRequests >= 1 && request.maxRequests <= 4096, 'INVALID_INPUT', 'External tool request cap must be an integer in [1, 4096]');
  const result = await options.runner!.run(request, options.signal);
  invariant(result && Number.isSafeInteger(result.exitCode) && Number.isSafeInteger(result.requestsMade) && Number.isSafeInteger(result.durationMs) && result.requestsMade >= 0 && result.requestsMade <= request.maxRequests, 'UNAVAILABLE', 'External runner returned an invalid result envelope');
  invariant(SHA256.test(result.stdoutSha256) && SHA256.test(result.stderrSha256) && SHA256.test(result.artifactDigest), 'UNAVAILABLE', 'External runner did not return digested output');
  return deepFreeze({
    kind: 'external-tool-run' as const,
    tool: identity.tool, version: identity.version, imageRef: identity.imageRef,
    binarySha256: identity.binarySha256, seccompProfileSha256: identity.seccompProfileSha256,
    networkPolicy: identity.networkPolicy, platform: identity.platform,
    identityDigest: externalToolIdentityDigest(identity),
    exitCode: result.exitCode, requestsMade: result.requestsMade, durationMs: result.durationMs,
    stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256, artifactDigest: result.artifactDigest,
    isolation: 'pinned-lab-image:no-host-execution',
    limits: EXTERNAL_TOOL_LIMITS,
  });
}

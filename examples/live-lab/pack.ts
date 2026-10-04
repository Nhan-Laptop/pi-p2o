// Pinned container-sandbox options for the live slice, read from `containers/pack.lock.json`.
//
// `mode: "authorized-assessment"` refuses a `local-fixture` sandbox, so the live composition runs every
// capability through the pinned offline execution pack (digest-pinned image, content-addressed rootfs layer
// pin, pinned engine release, pinned seccomp profile, non-root read-only container with no network). Nothing
// here is invented: every value is read from the locked pack and re-verified by `createContainerSandbox`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContainerSandboxOptions } from '../../src/tools/index.js';

export interface PackLock {
  lockVersion: number;
  packVersion: string;
  nodeVersion: string;
  engineVersion: string;
  base: { tag: string; indexDigest: string; imageRef: string; localBaseImageId: string; rootfsLayers: string[] };
  sources: { workerSha256: string; sourceSha256: string; seccompSha256: string };
  image: { pin: string; tag: string; platform: string; rootfsLayers: string[] };
}

export interface PackPaths {
  lockPath: string;
  seccompPath: string;
}

export function packPaths(repoRoot: string): PackPaths {
  return { lockPath: join(repoRoot, 'containers', 'pack.lock.json'), seccompPath: join(repoRoot, 'containers', 'seccomp.json') };
}

export function readPackLock(lockPath: string): PackLock {
  return JSON.parse(readFileSync(lockPath, 'utf8')) as PackLock;
}

/**
 * The exact `sandbox.options` document the owner approves for this run. `inputRoot` is the hashed lab source
 * snapshot and `outputRoot` is the broker artifact root; both are private run directories created by the
 * harness before the composition starts.
 */
export function buildContainerSandboxOptions(input: {
  repoRoot: string;
  inputRoot: string;
  outputRoot: string;
  approvedBy: string;
  expiresAt: string;
}): ContainerSandboxOptions {
  const { lockPath, seccompPath } = packPaths(input.repoRoot);
  const lock = readPackLock(lockPath);
  return {
    enginePath: '/usr/bin/docker',
    engineVersion: lock.engineVersion,
    image: lock.image.pin,
    imageRootfsLayers: [...lock.image.rootfsLayers],
    baseImageId: lock.base.localBaseImageId,
    workerSha256: lock.sources.workerSha256,
    sourceSha256: lock.sources.sourceSha256,
    seccompPath,
    seccompSha256: lock.sources.seccompSha256,
    inputRoot: input.inputRoot,
    outputRoot: input.outputRoot,
    trustedInputSnapshot: true,
    maxFileBytes: 1_048_576,
    maxArtifactBytes: 4_194_304,
    maxArtifacts: 128,
    qualification: {
      acknowledgement: 'containers-share-host-kernel-not-hostile-code-isolation',
      dedicatedLab: true,
      approvedBy: input.approvedBy,
      expiresAt: input.expiresAt,
      // The live lab only needs the lexical source analyzer and the broker-side HTTP client.
      nativeEnabled: false,
    },
  };
}

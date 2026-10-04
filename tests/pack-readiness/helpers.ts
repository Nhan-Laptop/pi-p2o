import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OnboardingReady } from '../../src/application/onboarding/types.js';
import { validateOwnerConfiguration } from '../../src/application/onboarding/configuration.js';
import { packConfigurationDigest, type PackBoundaryConfiguration, type PackSelection } from '../../src/application/pack-readiness/index.js';
export async function fixture() {
  const base = await mkdtemp('/tmp/p2o-packs-');
  const cwd = join(base, 'cwd'), target = join(base, 'input'), outputRoot = join(base, 'output'), storageRoot = join(base, 'consents');
  for (const path of [cwd, target, outputRoot]) await mkdir(path, { mode: 0o700 });
  const configuration = validateOwnerConfiguration({ schemaVersion: 1, owner: { uid: process.getuid!() }, scope: { target: { kind: 'local-dir', raw: target, locator: target }, boundary: 'directory-tree-no-symlinks' }, authorization: { basis: 'owner', reference: 'I own this fixture', attestation: 'human-self-attested' }, permissions: { readStatic: true, repositoryScripts: false, stateChanges: false }, allowedActions: ['read', 'analyze'], limits: { maxCostUsd: 1, maxRequests: 20, maxTokens: 1000, maxToolCalls: 20, maxAttempts: 1, deadlineMs: Date.now() + 120000, concurrency: 1 }, disclosure: { version: 1, modelCosts: true, modelDataSharing: true, planOnlyTargetIO: 0 } });
  const owner: OnboardingReady = { status: 'ready', configuration, effectiveLimits: configuration.limits, effectivePermissions: configuration.permissions, reused: false, configPath: '', receiptPath: '' };
  const boundary: PackBoundaryConfiguration = { kind: 'trusted-local', trustedOwnerModules: true, settings: { acknowledgement: 'local-fixtures-only-not-hostile-code-isolation', inputRoot: target, outputRoot, trustedInputSnapshot: true } };
  const selection: PackSelection = { packs: ['static'], actions: ['read', 'analyze'], maxRequests: 10, maxCalls: 10, deadlineMs: configuration.limits.deadlineMs, configurationDigest: packConfigurationDigest(boundary) };
  return { base, cwd, target, outputRoot, storageRoot, owner, boundary, boundaryConfiguration: boundary, selection, cleanup: () => rm(base, { recursive: true, force: true }) };
}

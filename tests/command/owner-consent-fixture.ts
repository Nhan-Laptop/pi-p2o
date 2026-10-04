/** CONTRACT ONLY: preconfigured-owner double for legacy command tests. No UI/storage or live execution claim. */
import { onboardingScopeFor, type OnboardingHandler } from '../../src/application/onboarding/index.js';
export const contractOwnerConsent: OnboardingHandler = async input => {
  const configuration = {
    schemaVersion: 1 as const, owner: { uid: process.getuid!() }, scope: onboardingScopeFor(input.target, input.cwd),
    authorization: { basis: 'owner' as const, reference: 'CONTRACT ONLY owner fixture', attestation: 'human-self-attested' as const },
    permissions: { readStatic: true as const, repositoryScripts: false, stateChanges: false },
    allowedActions: ['read' as const, 'analyze' as const],
    limits: { maxCostUsd: 5, maxRequests: 20, maxTokens: 100_000, maxToolCalls: 20, maxAttempts: 2,
      deadlineMs: Date.now() + 60 * 60_000, concurrency: 1, ...input.limits },
    disclosure: { version: 1 as const, modelCosts: true as const, modelDataSharing: true as const, planOnlyTargetIO: 0 as const },
  };
  return { status: 'ready', configuration, effectiveLimits: configuration.limits, effectivePermissions: configuration.permissions,
    configPath: '/contract-only/no-file.json', receiptPath: '/contract-only/no-file.json', reused: true };
};

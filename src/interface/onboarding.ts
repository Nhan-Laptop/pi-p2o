import { consentCovers, ensureOwnerOnboarding, onboardingScopeFor, validateOwnerConfiguration, type OnboardingHandler, type OnboardingInput, type OnboardingReady } from '../application/onboarding/index.js';
import { actionsFor, validateLimits } from '../application/onboarding/configuration.js';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { EntryPreparation, EntryTarget } from './target-entry.js';
import { InterfaceError } from './types.js';

/** Shared human-command adapter. Never called from a p2o_* tool. */
export async function onboardCommandTarget(ctx: ExtensionCommandContext, target: EntryTarget, handler: OnboardingHandler = ensureOwnerOnboarding,
  budgetUsd?: number, concurrency?: number,
  request?: Pick<OnboardingInput, 'limits' | 'permissions' | 'mode' | 'profile' | 'basis' | 'reference'>): Promise<OnboardingReady> {
  const result = await handler({ target, cwd: ctx.cwd, hasUI: ctx.hasUI, ui: ctx.ui, signal: ctx.signal,
    ...(request?.mode !== undefined ? { mode: request.mode } : {}),
    ...(request?.profile !== undefined ? { profile: request.profile } : {}),
    ...(request?.basis !== undefined ? { basis: request.basis } : {}),
    ...(request?.reference !== undefined ? { reference: request.reference } : {}),
    permissions: request?.permissions,
    limits: { ...(budgetUsd !== undefined ? { maxCostUsd: budgetUsd } : {}), ...(concurrency !== undefined ? { concurrency } : {}), ...request?.limits } });
  if (result.status === 'unsupported') throw new InterfaceError(result.code, result.message);
  if (result.status === 'cancelled') throw new InterfaceError('ONBOARDING_CANCELLED', 'you cancelled owner consent; nothing was configured, planned or launched');
  const configuration = validateOwnerConfiguration(result.configuration);
  if (!consentCovers(configuration, onboardingScopeFor(target, ctx.cwd))) {
    throw new InterfaceError('ONBOARDING_SCOPE_EXPANSION', 'onboarding returned consent for a different target or expired deadline');
  }
  validateLimits(result.effectiveLimits);
  const effective = validateOwnerConfiguration({ ...configuration, limits: result.effectiveLimits,
    permissions: result.effectivePermissions, allowedActions: actionsFor(result.effectivePermissions) });
  if (!consentCovers(configuration, onboardingScopeFor(target, ctx.cwd), effective.limits, effective.permissions) ||
    effective.limits.deadlineMs <= Date.now()) {
    throw new InterfaceError('ONBOARDING_BUDGET_EXPANSION', 'effective run limits/rights exceed saved owner consent or deadline');
  }
  return Object.freeze({ ...result, configuration, effectiveLimits: effective.limits, effectivePermissions: effective.permissions });
}
/** Refuse a backend/model plan that exceeds owner consent even if it claims that no requests were sent. */
export function assertOwnerPreparation(owner: OnboardingReady, preparation: EntryPreparation, cwd: string): void {
  const config = owner.configuration;
  // Static read/clone only: a public-source-review consent can never prepare an HTTP/host-interaction target.
  if (config.authorization.basis === 'public-source-review' && preparation.target.kind === 'http-url') {
    throw new InterfaceError('ONBOARDING_RIGHTS_EXPANSION', 'public source review covers static read/clone only; it cannot prepare an HTTP target or host checks');
  }
  const limits = owner.effectiveLimits;
  if (limits.deadlineMs <= Date.now() || !consentCovers(config, onboardingScopeFor(preparation.target, cwd), limits, owner.effectivePermissions)) {
    throw new InterfaceError('ONBOARDING_SCOPE_EXPANSION', 'prepared target/deadline exceeds saved owner consent; re-run --target interactively to review scope');
  }
  if (!Array.isArray(preparation.actions) || preparation.actions.length === 0 ||
    preparation.actions.some(action => !actionsFor(owner.effectivePermissions).includes(action as typeof config.allowedActions[number]))) {
    throw new InterfaceError('ONBOARDING_RIGHTS_EXPANSION', 'prepared actions exceed your separate rights opt-ins; review owner consent before planning or launch');
  }
  for (const key of ['maxCostUsd', 'maxRequests', 'maxTokens', 'maxToolCalls', 'maxAttempts'] as const) {
    const value = preparation.spend?.[key];
    if (!Number.isFinite(value) || value <= 0 || value > limits[key]) {
      throw new InterfaceError('ONBOARDING_BUDGET_EXPANSION', `prepared ${key} exceeds your approved budget; renew owner consent interactively`);
    }
  }
  if (!Number.isSafeInteger(preparation.concurrency) || preparation.concurrency <= 0 || preparation.concurrency > limits.concurrency) {
    throw new InterfaceError('ONBOARDING_BUDGET_EXPANSION', 'prepared concurrency exceeds your approved limit');
  }
  // Composition must enforce owner.effectiveLimits.deadlineMs (absolute epoch) at dispatch. EntrySpend.deadlineMs
  // is the existing port's relative duration, not an epoch; it cannot replace the owner's absolute deadline.
}

/** Opt-in human command API. Integration owns plan approval and runtime wiring; no implicit first-use change. */
export async function prepareCommandPacks(ctx: { cwd: string; hasUI: boolean; ui: import('../application/onboarding/types.js').OnboardingUI; signal?: AbortSignal }, owner: OnboardingReady,
  configuration: import('../application/pack-readiness/index.js').PackBoundaryConfiguration,
  request?: Partial<Omit<import('../application/pack-readiness/index.js').PackSelection, 'configurationDigest'>>,
  options: { storageRoot?: string; budgets?: import('../policy/budget.js').TargetBudget;
    controllerLifecycle?: import('../tools/container.js').ContainerSandboxOptions['controllerLifecycle'];
    prepareAction?: import('../application/pack-readiness/index.js').LocalPreparationAction } = {}) {
  const { ensurePackConsent, selectCapabilityPacks } = await import('../application/onboarding/packs.js');
  const { PACKS, packConfigurationDigest, checkPackReadiness, prepareLocalPackAction, planOperatorSetup } = await import('../application/pack-readiness/index.js');
  const required = request?.packs ?? ['static'];
  if (ctx.signal?.aborted) return { status: 'cancelled' as const };
  if (ctx.hasUI && !await selectCapabilityPacks(ctx.ui, required)) return { status: 'cancelled' as const };
  const consent = await ensurePackConsent({ owner, cwd: ctx.cwd, storageRoot: options.storageRoot, signal: ctx.signal, boundaryConfiguration: configuration,
    ui: ctx.hasUI ? ctx.ui : undefined, selection: { packs: required, actions: request?.actions ?? (['read', 'analyze'] as const).filter(action => required.some(p => (PACKS[p].actions as readonly string[]).includes(action))),
      maxRequests: request?.maxRequests ?? owner.effectiveLimits.maxRequests, maxCalls: request?.maxCalls ?? owner.effectiveLimits.maxToolCalls,
      deadlineMs: request?.deadlineMs ?? owner.effectiveLimits.deadlineMs, configurationDigest: packConfigurationDigest(configuration) } });
  if (consent.status !== 'consented') return consent;
  let result = await checkPackReadiness({ consent: consent.consent, configuration, budgets: options.budgets, signal: ctx.signal, controllerLifecycle: options.controllerLifecycle });
  if (result.status === 'blocked' && options.prepareAction) {
    const prepared = await prepareLocalPackAction({ consent: consent.consent, action: options.prepareAction, ui: ctx.hasUI ? ctx.ui : undefined, signal: ctx.signal });
    if (prepared !== 'prepared') return { status: prepared };
    result = await checkPackReadiness({ consent: consent.consent, configuration, budgets: options.budgets, signal: ctx.signal, controllerLifecycle: options.controllerLifecycle });
  }
  return result.status === 'blocked' ? { ...result, setup: planOperatorSetup(result.blockers) } : result;
}

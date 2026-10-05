import { actionsFor, boundedText, consentCovers, LIMIT_CEILINGS, onboardingScopeFor, ownerUid, profileLimits, validateLimits, validateOwnerConfiguration } from './configuration.js';
import { assertStorageOutsideTarget, defaultOwnerStorageRoot, findOwnerConsent, ownerConfigPath, publishOwnerConsent } from './storage.js';
import { OnboardingError, type OnboardingInput, type OnboardingOptions, type OnboardingResult, type OwnerConfiguration, type OwnerLimits } from './types.js';
import { assertBundledRuntimeReady } from './runtime-prerequisites.js';
export const MODEL_DISCLOSURE = 'Ordinary target runs have no application token/USD cap. Observed usage is durably recorded as information; provider charges still accrue. Native selected-model context/output constraints and independent lifecycle controls remain. Planning uses an assessment model you explicitly select in the human UI; your parent Pi model is not assessment consent. Model calls may incur provider charges, including --plan-only. Target identifiers and approved context may be sent to the selected provider. Legacy explicitly bounded managed runs retain their saved financial policy. No target I/O or worker execution is permitted during preparation/planning. Scope consent is not approval of a model plan; you will review its exact digest separately.';
class Cancelled extends Error {}
/** Honest bases only. `public-source-review` exists because a public repository is neither owned, nor covered by
 *  written permission, nor covered by a published program; it grants static read/clone and nothing more. */
const BASIS = ['I own/control this target', 'I have written permission', 'A published program authorizes this scope',
  'Public source review only — read/clone static public source; no host testing'];
const PUBLIC_SOURCE_REVIEW = BASIS[3];
const PUBLIC_SOURCE_REFERENCE = 'Public source review: publicly accessible source only; read/clone and static analysis; no host testing, no repository scripts, no state changes';
const SCRIPT = ['No — keep repository scripts disabled', 'Yes — separately allow repository scripts'];
const CHANGE = ['No — keep state changes disabled', 'Yes — separately allow state changes'];
function abort(input: OnboardingInput): void { if (input.signal?.aborted) throw new Cancelled(); }

/** Render an absolute deadline for a dialog; the validated maximum is an explicit "no expiry", not a date. */
function deadlineText(deadlineMs: number): string {
  return Number.isFinite(deadlineMs) && deadlineMs <= 8.64e15 ? new Date(deadlineMs).toISOString() : 'no expiry (validated maximum)';
}
/** First-use HUMAN UI only. This function never constructs a backend, calls a model, or reads a target. */
export async function ensureOwnerOnboarding(input: OnboardingInput, options: OnboardingOptions = {}): Promise<OnboardingResult> {
  // Bundled-runtime readiness precedes every consent dialog (and the UI check): an installation that cannot
  // reach prepare() must never collect owner consent. Fails with BUNDLED_RUNTIME_MISSING naming every
  // missing path, so the owner learns immediately instead of after consenting to a raw ENOENT.
  assertBundledRuntimeReady(options.runtime);
  if (!input.hasUI || !input.ui || ['confirm', 'select', 'input'].some(method => typeof (input.ui as unknown as Record<string, unknown>)[method] !== 'function')) {
    return { status: 'unsupported', code: 'ONBOARDING_UI_UNSUPPORTED', message: 'First-use /p2o owner consent requires human select/input/confirm dialogs. This host has no supported UI; nothing was configured, planned or launched. Use an interactive Pi session (or a human-operated RPC UI).' };
  }
  const ui = input.ui, now = options.now ?? Date.now;
  const scope = onboardingScopeFor(input.target, input.cwd);
  const root = options.storageRoot ?? defaultOwnerStorageRoot();
  assertStorageOutsideTarget(root, input.cwd, scope);
  const readyResult = (configuration: OwnerConfiguration, path: string, reused: boolean): OnboardingResult => {
    const effectiveLimits = { ...configuration.limits };
    for (const key of Object.keys(effectiveLimits) as Array<Exclude<keyof OwnerLimits, 'modelAccounting'>>) {
      if (key === 'modelAccounting' as string) continue;
      const requested = input.limits?.[key], approved = effectiveLimits[key];
      if (typeof requested === 'number') effectiveLimits[key] = approved === null ? requested : Math.min(approved, requested);
    }
    if (effectiveLimits.maxTokens !== null || effectiveLimits.maxCostUsd !== null) delete effectiveLimits.modelAccounting;
    const effectivePermissions = { ...configuration.permissions,
      repositoryScripts: configuration.permissions.repositoryScripts && input.permissions?.repositoryScripts !== false,
      stateChanges: configuration.permissions.stateChanges && input.permissions?.stateChanges !== false };
    return { status: 'ready', configuration, configPath: path, receiptPath: path, reused,
      effectiveLimits: Object.freeze(effectiveLimits), effectivePermissions: Object.freeze(effectivePermissions) };
  };
  const defaults: OwnerLimits = { maxCostUsd: 5, maxRequests: 20, maxTokens: 100_000, maxToolCalls: 20, maxAttempts: 2, deadlineMs: now() + 60 * 60_000, concurrency: 1 };
  if (input.limits) {
    if (Object.keys(input.limits).some(key => !Object.hasOwn(LIMIT_CEILINGS, key))) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'unknown requested budget field');
    if (input.limits.maxCostUsd !== undefined || input.limits.maxTokens !== undefined) {
      throw new OnboardingError('ONBOARDING_BUDGET_REMOVED', 'application token/USD caps were removed from ordinary /p2o target consent; model usage is informational and provider-limited');
    }
    validateLimits({ ...defaults, ...input.limits });
    if (input.limits.deadlineMs !== undefined && input.limits.deadlineMs <= now()) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'requested deadline has expired');
  }
  if (input.permissions && (Object.keys(input.permissions).some(key => !['repositoryScripts', 'stateChanges'].includes(key)) ||
    Object.values(input.permissions).some(value => typeof value !== 'boolean'))) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'invalid requested permissions');
  if (scope.target.kind === 'http-url' && input.permissions?.repositoryScripts) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'repository scripts require a repository target');
  if (input.mode !== undefined && !['quick', 'guided'].includes(input.mode)) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'unknown onboarding mode');
  if (input.profile !== undefined && !['conservative', 'wide', 'ceiling'].includes(input.profile)) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'unknown ceiling profile');
  if (input.basis !== undefined && !['owner', 'written-permission', 'published-program', 'public-source-review'].includes(input.basis)) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'unknown authorization basis');
  if (input.reference !== undefined && input.basis === undefined && (input.mode ?? 'guided') === 'quick' && input.reference.trim().length === 0) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'authorization reference must not be blank');
  const quick = (input.mode ?? 'guided') === 'quick';
  // Quick mode derives every value from the selected profile, so the reuse decision must consider the whole
  // profile: a wider request must never be satisfied silently by a narrower saved consent.
  const quickProfile = profileLimits(input.profile ?? 'wide', now());
  const quickLimits: OwnerLimits | undefined = quick ? { ...quickProfile, ...input.limits } : undefined;
  // The profile deadline is a *default*, not a request: a repeated identical run must reuse saved consent instead of
  // re-asking merely because "twelve hours from now" moved. An explicit deadline request is a real request.
  const quickCaps: Partial<OwnerLimits> = { ...(quickProfile.modelAccounting ? { modelAccounting: quickProfile.modelAccounting } : {}), maxCostUsd: quickProfile.maxCostUsd, maxRequests: quickProfile.maxRequests,
    maxTokens: quickProfile.maxTokens, maxToolCalls: quickProfile.maxToolCalls, maxAttempts: quickProfile.maxAttempts, concurrency: quickProfile.concurrency };
  const requestedLimits = quick ? { ...quickCaps, ...input.limits } : input.limits;
  try {
    abort(input);
    const previous = await findOwnerConsent(root, scope, requestedLimits, input.permissions, now());
    abort(input);
    if (previous && consentCovers(previous.configuration, scope, requestedLimits, input.permissions, now())) {
      ui.notify?.(`Reusing your saved exact scope and bounds. ${MODEL_DISCLOSURE}`, 'info');
      const path = ownerConfigPath(root, previous.configuration.scope);
      return readyResult(previous.configuration, path, true);
    }
    const dialogOptions = input.signal ? { signal: input.signal } : undefined;
    const confirm = async (title: string, message: string): Promise<void> => {
      abort(input);
      if (await ui.confirm(title, message, dialogOptions) !== true) throw new Cancelled();
      abort(input);
    };
    const select = async (title: string, choices: string[]): Promise<string> => {
      abort(input);
      const value = await ui.select(title, choices, dialogOptions);
      abort(input);
      if (value === undefined) throw new Cancelled();
      if (!choices.includes(value)) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'UI returned an unknown choice');
      return value;
    };
    const text = async (title: string, fallback?: string): Promise<string> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        abort(input);
        const value = await ui.input(title, fallback, dialogOptions);
        abort(input);
        if (value === undefined) throw new Cancelled();
        try { return boundedText(value.trim() || fallback, title, 512); }
        catch (error) { ui.notify?.(error instanceof OnboardingError ? error.message : 'Invalid input', 'warning'); }
      }
      throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'too many invalid dialog responses; no consent saved');
    };
    const number = async (title: string, fallback: number, max: number, decimal = false): Promise<number> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const value = await text(`${title} (blank keeps ${fallback})`, String(fallback));
        const pattern = decimal ? /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/ : /^[1-9]\d*$/;
        const parsed = Number(value);
        if (pattern.test(value) && Number.isFinite(parsed) && parsed > 0 && parsed <= max) return parsed;
        ui.notify?.(`Enter a positive ${decimal ? 'USD amount (at most two decimals)' : 'integer'} no greater than ${max}`, 'warning');
      }
      throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'invalid owner budget; no consent saved');
    };
    // ------------------------------------------------------------------ one-dialog quick consent
    if (quick) {
      const basisKey = input.basis ?? (scope.target.kind === 'github-repo' ? 'public-source-review' : 'owner');
      const publicSourceReview = basisKey === 'public-source-review';
      if (publicSourceReview && scope.target.kind === 'http-url') {
        throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'public source review is static read/clone only; a single URL target implies host interaction and needs an owner/written-permission/published-program basis');
      }
      // Rights are off unless this invocation explicitly requested them, and public source review never carries them.
      const repositoryScripts = !publicSourceReview && input.permissions?.repositoryScripts === true;
      const stateChanges = !publicSourceReview && input.permissions?.stateChanges === true;
      if (repositoryScripts && scope.target.kind === 'http-url') throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'repository scripts require a repository target');
      const reference = boundedText(input.reference ?? (basisKey === 'owner' ? BASIS[0] : publicSourceReview ? PUBLIC_SOURCE_REFERENCE : BASIS[1]), 'authorization reference', 512);
      const configuration: OwnerConfiguration = validateOwnerConfiguration({
        schemaVersion: 1, owner: { uid: ownerUid() }, scope,
        authorization: { basis: basisKey, reference, attestation: 'human-self-attested' },
        permissions: { readStatic: true, repositoryScripts, stateChanges },
        allowedActions: actionsFor({ readStatic: true, repositoryScripts, stateChanges }),
        limits: quickLimits!,
        disclosure: { version: 1, modelCosts: true, modelDataSharing: true, planOnlyTargetIO: 0 },
      });
      const limits = configuration.limits;
      const basisText = basisKey === 'owner' ? 'I own/control this target (your attestation; not independent ownership proof)'
        : basisKey === 'written-permission' ? 'I have written permission (your attestation; keep the document)'
        : basisKey === 'published-program' ? 'A published program authorizes this scope (your attestation)'
        : 'Public source review only — static read/clone of public source, no host testing';
      // A renewal/expansion is labelled as such so a wider consent is never mistaken for the first one.
      const quickTitle = previous ? 'Scope/rights/limits renewal or expansion: save this scope, rights and limits?' : 'First-use owner consent: save this scope, rights and limits?';
      await confirm(quickTitle,
        `Target: ${scope.target.kind} ${scope.target.locator}\nScope: ${scope.boundary}\n`
        + `Authorization: ${basisText}\nReference: ${reference}\n`
        + (publicSourceReview ? 'Public source review is static read/clone and static analysis only: no host testing, no HTTP requests against the repository host, no scripts, no state changes.\n' : '')
        + `Separate rights: repository scripts ${repositoryScripts ? 'ON' : 'OFF'}, state changes ${stateChanges ? 'ON' : 'OFF'}\n`
        + `Your rights: ${configuration.allowedActions.join(', ')}\n`
        + (limits.modelAccounting === 'informational' ? `Model usage: informational durable accounting; no application token/USD caps; provider-limited completions. Operational scope: ${limits.maxRequests} target requests, ${limits.maxToolCalls} tool calls, ${limits.maxAttempts} attempts; concurrency ${limits.concurrency}; deadline ${deadlineText(limits.deadlineMs)}\n` : `Legacy bounded consent: up to $${limits.maxCostUsd}; ${limits.maxTokens} model tokens; concurrency ${limits.concurrency}; deadline ${deadlineText(limits.deadlineMs)}\n`)
        + `${MODEL_DISCLOSURE}\n`
        + `Save outside the target at ${root}, owner-only. Nothing is saved if you cancel this dialog.`);
      abort(input);
      const path = await publishOwnerConsent(root, configuration, previous?.receipt.configurationDigest ?? null, now());
      ui.notify?.(`Saved owner configuration and scope-consent receipt: ${path}. This is not approval of a model plan.`, 'info');
      return readyResult(configuration, path, false);
    }

    const renewal = previous ? 'Scope/rights/limits renewal or expansion' : 'First-use owner consent';
    await confirm(`${renewal}: confirm target and scope?`,
      `Target: ${scope.target.kind} ${scope.target.locator}\nScope: ${scope.boundary}\nNo additional hosts, URL paths, redirects, symlink targets or repositories are included. No target has been read or contacted. Only authorize a scope you are legally entitled to assess.${scope.target.kind === 'github-repo' ? '\nRepository scope does not approve an unobserved commit/tree. Execution requires separate approval of the acquired immutable source identity.' : ''}`);
    const basis = await select('What is your authorization basis for this exact scope?', BASIS);
    const publicSourceReview = basis === PUBLIC_SOURCE_REVIEW;
    const reference = await text('Authorization reference (description/document/program; no passwords or tokens)',
      basis === BASIS[0] ? 'I attest that I own/control this exact target' : publicSourceReview ? PUBLIC_SOURCE_REFERENCE : undefined);
    if (publicSourceReview && scope.target.kind === 'http-url') {
      throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'public source review is static read/clone only; a single URL target implies host interaction and needs an owner/written-permission/published-program basis');
    }
    // A separate opt-in for each right. Neither a flag nor a model answer silently grants it.
    // Public source review never offers script or state rights: it is static read/clone only.
    const repositoryScripts = publicSourceReview || scope.target.kind === 'http-url' ? false :
      await select('Read/static analysis is the default. Separately permit running repository scripts? Scripts execute target-authored code.', SCRIPT) === SCRIPT[1];
    const stateChanges = publicSourceReview ? false :
      await select('Separately permit state-changing actions on this exact target? This does not authorize extra scope or unreviewed model plans.', CHANGE) === CHANGE[1];
    const base = { ...defaults, ...(previous?.configuration.limits ?? {}), ...input.limits };
    if (base.deadlineMs <= now()) base.deadlineMs = now() + 60 * 60_000;
    // A legacy bounded consent is preserved verbatim: the guided flow has no financial dialog any more, so it
    // must never silently strip caps the owner saved earlier. Fresh guided consents are informational.
    const previousBounded = previous !== null && previous.configuration.limits.modelAccounting !== 'informational';
    const maxCostUsd = previousBounded ? previous!.configuration.limits.maxCostUsd : null;
    const maxRequests = await number('Maximum target requests (after separate plan approval)', base.maxRequests, LIMIT_CEILINGS.maxRequests);
    const maxTokens = previousBounded ? previous!.configuration.limits.maxTokens : null;
    const maxToolCalls = await number('Maximum tool calls', base.maxToolCalls, LIMIT_CEILINGS.maxToolCalls);
    const maxAttempts = await number('Maximum worker attempts', base.maxAttempts, LIMIT_CEILINGS.maxAttempts);
    const concurrency = await number('Maximum concurrent workers', base.concurrency, LIMIT_CEILINGS.concurrency);
    const minutesDefault = Math.max(1, Math.ceil((base.deadlineMs - now()) / 60_000));
    const minutes = await number(`Deadline in minutes from now; existing deadline ${new Date(base.deadlineMs).toISOString()}`, minutesDefault, 10_080);
    // Blank/default keeps the exact absolute deadline rather than silently renewing a saved authorization.
    const deadlineMs = minutes === minutesDefault ? base.deadlineMs : now() + minutes * 60_000;
    const permissions = { readStatic: true as const, repositoryScripts, stateChanges };
    const configuration: OwnerConfiguration = validateOwnerConfiguration({
      schemaVersion: 1, owner: { uid: ownerUid() }, scope,
      authorization: { basis: basis === BASIS[0] ? 'owner' : basis === BASIS[1] ? 'written-permission' : basis === BASIS[2] ? 'published-program' : 'public-source-review', reference, attestation: 'human-self-attested' },
      permissions, allowedActions: actionsFor(permissions),
      limits: previousBounded
        ? { maxCostUsd: maxCostUsd!, maxRequests, maxTokens: maxTokens!, maxToolCalls, maxAttempts, deadlineMs, concurrency }
        : { modelAccounting: 'informational', maxCostUsd, maxRequests, maxTokens, maxToolCalls, maxAttempts, deadlineMs, concurrency },
      disclosure: { version: 1, modelCosts: true, modelDataSharing: true, planOnlyTargetIO: 0 },
    });
    await confirm('Save this owner-only scope consent?',
      `Target: ${scope.target.locator}\nScope: ${scope.boundary}\nAuthorization: ${configuration.authorization.basis} — ${reference} (your attestation; not independent ownership proof)\nActions: ${configuration.allowedActions.join(', ')}\nSeparate rights: repository scripts ${repositoryScripts ? 'ON' : 'OFF'}, state changes ${stateChanges ? 'ON' : 'OFF'}\n${publicSourceReview ? 'Public source review is static read/clone and static analysis only: no host testing, no HTTP requests against the repository host, no scripts, no state changes.\n' : ''}${previousBounded ? `Legacy bounded consent preserved: up to $${maxCostUsd}; ${maxTokens} model tokens\n` : `Model usage: informational durable accounting; no application token/USD caps; provider-limited completions\n`}${maxRequests} target requests, ${maxToolCalls} tool calls, ${maxAttempts} attempts; concurrency ${concurrency}; deadline ${new Date(deadlineMs).toISOString()}\n${MODEL_DISCLOSURE}\nSave outside the target at ${root}, owner-only. Nothing is saved if you cancel this dialog.`);
    abort(input);
    const path = await publishOwnerConsent(root, configuration, previous?.receipt.configurationDigest ?? null, now());
    ui.notify?.(`Saved owner configuration and scope-consent receipt: ${path}. This is not approval of a model plan.`, 'info');
    return readyResult(configuration, path, false);
  } catch (error) {
    if (error instanceof Cancelled) return { status: 'cancelled' };
    throw error;
  }
}

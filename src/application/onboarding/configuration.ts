import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { OnboardingError, type OnboardingProfile, type OnboardingTarget, type OwnerConfiguration, type OwnerLimits, type OwnerPermissions, type OwnerScope } from './types.js';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const SECRET = /\b(?:password|passwd|api[_-]?key|access[_-]?token|token|secret|credential|authorization|cookie)\s*[:=]|\bBearer\s+\S+|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})|https?:\/\/[^/\s]*@/i;
export function ownerUid(): number {
  if (typeof process.getuid !== 'function') throw new OnboardingError('ONBOARDING_STORAGE_UNSUPPORTED', 'owner-only POSIX storage is required');
  return process.getuid();
}
export function boundedText(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value) || SECRET.test(value)) {
    throw new OnboardingError('ONBOARDING_INVALID_INPUT', `${label} must be bounded text without controls or credentials`);
  }
  return value.trim();
}
/** Syntax-only canonicalization. In particular: no stat, realpath, git, DNS, HTTP or source reads. */
export function onboardingScopeFor(target: OnboardingTarget, cwd: string): OwnerScope {
  const raw = boundedText(target.raw, 'target');
  let locator = boundedText(target.locator, 'target locator');
  if (target.kind === 'local-dir') {
    if (locator === '~' || locator.startsWith('~/')) locator = resolve(homedir(), locator.slice(2));
    else if (locator.startsWith('~')) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'named-user home expansion is unsupported');
    locator = resolve(cwd, locator);
    if (locator === '/') throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'the filesystem root cannot be an assessment scope');
    return { target: { kind: target.kind, raw, locator }, boundary: 'directory-tree-no-symlinks' };
  }
  let url: URL, rawUrl: URL;
  try { url = new URL(locator); rawUrl = new URL(raw); } catch { throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'target must be an absolute HTTP(S) URL'); }
  if ([url, rawUrl].some(candidate => !['http:', 'https:'].includes(candidate.protocol) || candidate.username || candidate.password || candidate.hash ||
    [...candidate.searchParams.keys()].some(key => /token|secret|password|api.?key|credential|signature/i.test(key)))) {
    throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'target URL must not contain credentials or fragments');
  }
  if (target.kind === 'github-repo') {
    const rawParts = rawUrl.pathname.split('/').filter(Boolean);
    if (rawUrl.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(rawUrl.hostname) || rawUrl.port || rawUrl.search || rawParts.length !== 2 ||
      `https://github.com/${rawParts[0]}/${rawParts[1].replace(/\.git$/i, '')}` !== url.href) {
      throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'GitHub selectors/queries are not an immutable repository scope; provide the repository URL and review source identity separately');
    }
    if (url.origin !== 'https://github.com' || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname) || url.search) {
      throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'repository scope must be one canonical HTTPS GitHub repository');
    }
    return { target: { kind: target.kind, raw, locator: url.href }, boundary: 'single-repository' };
  }
  if (target.kind !== 'http-url') throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'unsupported target kind');
  if (rawUrl.href !== url.href) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'raw and canonical target URLs disagree');
  return { target: { kind: target.kind, raw, locator: url.href }, boundary: 'exact-url-no-redirects' };
}
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function configurationDigest(configuration: OwnerConfiguration): string {
  return createHash('sha256').update(canonicalJSON(configuration)).digest('hex');
}
export function scopeKey(scope: OwnerScope): string {
  return createHash('sha256').update(canonicalJSON({ kind: scope.target.kind, locator: scope.target.locator, boundary: scope.boundary })).digest('hex');
}
export function actionsFor(permissions: OwnerPermissions): OwnerConfiguration['allowedActions'] {
  return ['read', 'analyze', ...(permissions.repositoryScripts ? ['repo-script' as const] : []), ...(permissions.stateChanges ? ['state-change' as const] : [])];
}
export type NumericLimitKey = Exclude<keyof OwnerLimits, 'modelAccounting'>;
export const LIMIT_CEILINGS: Omit<OwnerLimits, 'modelAccounting' | 'maxTokens' | 'maxCostUsd'> & { maxTokens: number; maxCostUsd: number } = {
  maxCostUsd: 100_000, maxRequests: 1_000_000, maxTokens: 10_000_000, maxToolCalls: 1_000_000,
  maxAttempts: 10_000, deadlineMs: Number.MAX_SAFE_INTEGER, concurrency: 64,
};
/**
 * Profile limits for the one-dialog quick path.
 *
 * `conservative` is the historic default; `wide` keeps a real money cap and a real deadline while leaving the
 * request/tool/attempt/token ceilings at the validated maximum, so an ordinary assessment never stops on an
 * artificial limit; `ceiling` uses the validated maxima for every field, including spend and deadline. Every
 * profile is finite: an unbounded spend cap or deadline is not a guard at all. `deadlineMs` is absolute, so
 * this takes the current time.
 */
/**
 * [L1] Ordinary (informational) per-task attempt ceiling. With no application money cap this durable retry
 * count plus the supervisor's consecutive-failure brake is the loop stop, so it must stay single-digit and
 * be shown in the consent dialog. A legacy owner who explicitly chose a numeric attempt budget keeps it.
 */
export const ORDINARY_MAX_ATTEMPTS = 3;
export function profileLimits(profile: OnboardingProfile, now: number): OwnerLimits {
  if (profile === 'conservative') {
    return { maxCostUsd: 5, maxRequests: 20, maxTokens: 100_000, maxToolCalls: 20, maxAttempts: 2, deadlineMs: now + 60 * 60_000, concurrency: 1 };
  }
  if (profile === 'ceiling') {
    return { ...LIMIT_CEILINGS };
  }
  return { modelAccounting: 'informational', maxCostUsd: null, maxRequests: LIMIT_CEILINGS.maxRequests, maxTokens: null,
    maxToolCalls: LIMIT_CEILINGS.maxToolCalls, maxAttempts: ORDINARY_MAX_ATTEMPTS,
    deadlineMs: now + 12 * 60 * 60_000, concurrency: 8 };
}

export function validateLimits(limits: OwnerLimits): void {
  if (limits.modelAccounting === 'informational' ? limits.maxTokens !== null || limits.maxCostUsd !== null : limits.maxTokens === null || limits.maxCostUsd === null) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'Informational accounting must be explicit; bounded legacy caps cannot disappear');
  for (const key of Object.keys(LIMIT_CEILINGS) as NumericLimitKey[]) {
    const value = limits[key];
    if (limits.modelAccounting === 'informational' && (key === 'maxTokens' || key === 'maxCostUsd')) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > LIMIT_CEILINGS[key] ||
      (key !== 'maxCostUsd' && !Number.isSafeInteger(value)) ||
      (key === 'maxCostUsd' && Math.abs(value * 100 - Math.round(value * 100)) > 1e-7)) {
      throw new OnboardingError('ONBOARDING_INVALID_INPUT', `invalid owner limit: ${key}`);
    }
  }
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) {
    throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'owner document has missing or unexpected fields');
  }
  return value as Record<string, unknown>;
}
/** Strict runtime schema: persisted data is never executable config and cannot smuggle extra grants. */
export function validateOwnerConfiguration(value: unknown): OwnerConfiguration {
  const config = object(value, ['schemaVersion', 'owner', 'scope', 'authorization', 'permissions', 'allowedActions', 'limits', 'disclosure']);
  if (config.schemaVersion !== 1) throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'unsupported owner configuration version');
  const owner = object(config.owner, ['uid']);
  if (owner.uid !== ownerUid()) throw new OnboardingError('ONBOARDING_CONFIG_UNTRUSTED', 'configuration belongs to a different OS owner');
  const scope = object(config.scope, ['target', 'boundary']);
  const target = object(scope.target, ['kind', 'raw', 'locator']);
  if (target.kind === 'local-dir' && (typeof target.locator !== 'string' || !isAbsolute(target.locator))) {
    throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'persisted local scope must be absolute');
  }
  const normalized = onboardingScopeFor(target as unknown as OnboardingTarget, '/');
  if (canonicalJSON(scope) !== canonicalJSON(normalized)) throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'persisted scope is not canonical');
  const auth = object(config.authorization, ['basis', 'reference', 'attestation']);
  if (!['owner', 'written-permission', 'published-program', 'public-source-review'].includes(String(auth.basis)) || auth.attestation !== 'human-self-attested') {
    throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'invalid authorization provenance');
  }
  boundedText(auth.reference, 'authorization reference', 512);
  const permissions = object(config.permissions, ['readStatic', 'repositoryScripts', 'stateChanges']);
  if (permissions.readStatic !== true || typeof permissions.repositoryScripts !== 'boolean' || typeof permissions.stateChanges !== 'boolean' ||
    (target.kind === 'http-url' && permissions.repositoryScripts)) throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'invalid action permissions');
  // Static read/clone only: a public-source-review consent can never carry script/state rights or a single-URL target.
  if (auth.basis === 'public-source-review' && (target.kind === 'http-url' || permissions.repositoryScripts === true || permissions.stateChanges === true)) {
    throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'public source review is static read/clone only: no HTTP target, no repository scripts, no state changes');
  }
  const actions = actionsFor(permissions as unknown as OwnerPermissions);
  if (canonicalJSON(config.allowedActions) !== canonicalJSON(actions)) throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'actions do not match human permissions');
  const limitKeys = Object.keys(LIMIT_CEILINGS);
  if ((config.limits as OwnerLimits)?.modelAccounting === 'informational') limitKeys.push('modelAccounting');
  object(config.limits, limitKeys);
  validateLimits(config.limits as OwnerLimits);
  const disclosure = object(config.disclosure, ['version', 'modelCosts', 'modelDataSharing', 'planOnlyTargetIO']);
  if (disclosure.version !== 1 || disclosure.modelCosts !== true || disclosure.modelDataSharing !== true || disclosure.planOnlyTargetIO !== 0) {
    throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'model-cost/data disclosure is required');
  }
  return freeze(JSON.parse(canonicalJSON(config)) as OwnerConfiguration);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Only exact URL/repository scope or lexical directory narrowing; dispatch must enforce the no-symlink boundary. */
export function consentCovers(configuration: OwnerConfiguration, scope: OwnerScope, limits: Partial<OwnerLimits> = {},
  permissions: Partial<OwnerPermissions> = {}, now = Date.now()): boolean {
  const approved = configuration.scope;
  const localNarrowing = approved.target.kind === 'local-dir' && scope.target.kind === 'local-dir' &&
    scope.boundary === approved.boundary && scope.target.locator.startsWith(`${approved.target.locator}/`);
  if ((!localNarrowing && scopeKey(approved) !== scopeKey(scope)) || configuration.limits.deadlineMs <= now) return false;
  if (limits.modelAccounting === 'informational' && configuration.limits.modelAccounting !== 'informational') return false;
  for (const key of Object.keys(limits) as Array<keyof OwnerLimits>) {
    if (key === 'modelAccounting') continue;
    const requested = limits[key], approved = configuration.limits[key];
    if (requested === null) { if (approved !== null || configuration.limits.modelAccounting !== 'informational') return false; continue; }
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0 || (approved !== null && requested > approved)) return false;
  }
  if (permissions.repositoryScripts && !configuration.permissions.repositoryScripts) return false;
  if (permissions.stateChanges && !configuration.permissions.stateChanges) return false;
  return true;
}

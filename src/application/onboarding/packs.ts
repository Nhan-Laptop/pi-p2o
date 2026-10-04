import { resolve } from 'node:path';
import { canonicalJSON, ownerUid, scopeKey, validateOwnerConfiguration } from './configuration.js';
import { assertStorageOutsideTarget, defaultOwnerStorageRoot, publishOwnerDocument, readOwnerDocument } from './storage.js';
import type { OnboardingReady, OnboardingUI } from './types.js';
import { PACKS, validateSelection, type PackId, type PackSelection } from '../pack-readiness/catalog.js';
import { digest, deepFreeze } from '../../policy/validation.js';
import { packConfigurationDigest, type PackBoundaryConfiguration } from '../pack-readiness/configuration.js';

export interface PackConsent {
  version: 1;
  source: 'human-ui';
  ownerUid: number;
  scopeDigest: string;
  authorizationDigest: string;
  selection: PackSelection;
  acknowledgements: string[];
  confirmedAt: number;
  digest: string;
}
const issued = new WeakSet<object>();
const consentTargets = new WeakMap<object, { target: string | undefined; cwd: string }>();
export function assertPreparationOutsideTarget(consent: PackConsent, destination: string): void {
  assertPackConsent(consent);
  const scope = consentTargets.get(consent);
  const contains = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
  if (!scope || [scope.target, scope.cwd].some(root => root && (contains(root, destination) || contains(destination, root)))) throw new Error('PACK_PREPARE_TARGET_IO_DENIED');
}
export function assertPackConsent(consent: PackConsent): void {
  if (!issued.has(consent) || consent.ownerUid !== ownerUid() || consent.selection.deadlineMs <= Date.now()) throw new Error('PACK_CONSENT_REQUIRED');
}
export function packConsentCovers(saved: PackSelection, requested: PackSelection): boolean {
  return saved.configurationDigest === requested.configurationDigest && requested.packs.every(p => saved.packs.includes(p)) &&
    requested.actions.every(a => saved.actions.includes(a)) && requested.maxRequests <= saved.maxRequests && requested.maxCalls <= saved.maxCalls && requested.deadlineMs <= saved.deadlineMs;
}
/** Selection helper for human commands only. Cancellation never becomes default acceptance. */
export async function selectCapabilityPacks(ui: OnboardingUI, required: readonly PackId[] = ['static']): Promise<PackId[] | undefined> {
  const result: PackId[] = [];
  for (const id of required) {
    if (!Object.hasOwn(PACKS, id)) throw new Error('PACK_SELECTION_INVALID');
    const pack = PACKS[id];
    const choices = ['Enable required pack', 'Block / revise plan'];
    const selected = await ui.select(`TOOL PACK ${id}: ${pack.description}\nTrust acknowledgement: ${pack.acknowledgement}`, choices);
    if (selected === undefined || selected === choices[1]) return undefined;
    if (selected !== choices[0]) throw new Error('PACK_UI_INVALID');
    result.push(id);
  }
  return result;
}
/** Persisted consent is data only, bound to owner scope, authorization, exact pins and bounds. */
export async function ensurePackConsent(input: { owner: OnboardingReady; cwd: string; selection: PackSelection; boundaryConfiguration: PackBoundaryConfiguration; ui?: OnboardingUI; storageRoot?: string; signal?: AbortSignal }): Promise<
  { status: 'consented'; consent: PackConsent; reused: boolean } | { status: 'cancelled' | 'unsupported' }> {
  const config = validateOwnerConfiguration(input.owner.configuration);
  const selection = validateSelection(input.selection);
  if (packConfigurationDigest(input.boundaryConfiguration) !== selection.configurationDigest) throw new Error('PACK_CONFIG_NOT_CONSENTED');
  const boundaryDescription = JSON.stringify(input.boundaryConfiguration, null, 2);
  if (boundaryDescription.length > 131072) throw new Error('PACK_CONFIG_TOO_LARGE');
  if (selection.maxRequests > Math.min(config.limits.maxRequests, input.owner.effectiveLimits.maxRequests) ||
    selection.maxCalls > Math.min(config.limits.maxToolCalls, input.owner.effectiveLimits.maxToolCalls) ||
    selection.deadlineMs > Math.min(config.limits.deadlineMs, input.owner.effectiveLimits.deadlineMs) || selection.deadlineMs <= Date.now() ||
    selection.actions.includes('mutate') && (!config.permissions.stateChanges || !input.owner.effectivePermissions.stateChanges) ||
    config.authorization.basis === 'public-source-review' && selection.packs.some(p => p !== 'static')) throw new Error('PACK_OWNER_BOUNDS_EXCEEDED');
  const scopeDigest = scopeKey(config.scope), authorizationDigest = digest(config.authorization);
  const root = input.storageRoot ?? defaultOwnerStorageRoot();
  assertStorageOutsideTarget(root, input.cwd, config.scope);
  if (input.signal?.aborted) return { status: 'cancelled' };
  const saved = await readOwnerDocument(root, `packs-${scopeDigest}`) as PackConsent | null;
  let reused = false;
  if (saved) {
    const { digest: savedDigest, ...body } = saved;
    if (Object.keys(saved).sort().join('|') !== ['version', 'source', 'ownerUid', 'scopeDigest', 'authorizationDigest', 'selection', 'acknowledgements', 'confirmedAt', 'digest'].sort().join('|') ||
      saved.version !== 1 || saved.source !== 'human-ui' || saved.ownerUid !== ownerUid() || saved.scopeDigest !== scopeDigest || savedDigest !== digest(body) ||
      !Number.isSafeInteger(saved.confirmedAt) || saved.confirmedAt > Date.now() || saved.confirmedAt >= saved.selection.deadlineMs ||
      canonicalJSON(saved.acknowledgements) !== canonicalJSON(saved.selection.packs.map(p => PACKS[p]?.acknowledgement))) throw new Error('PACK_CONSENT_INVALID');
    validateSelection(saved.selection);
    reused = saved.authorizationDigest === authorizationDigest && packConsentCovers(saved.selection, selection);
  }
  if (!reused) {
    if (!input.ui) return { status: 'unsupported' };
    const description = selection.packs.map(p => `${p}: ${PACKS[p].description}\n${PACKS[p].acknowledgement}`).join('\n');
    if (!await input.ui.confirm('Consent to scoped TOOL PACK preflight and grant material?', `${description}\nScope: ${config.scope.target.locator} (${config.scope.boundary})\nActions: ${selection.actions.join(', ')}; requests ${selection.maxRequests}; calls ${selection.maxCalls}; deadline ${new Date(selection.deadlineMs).toISOString()}\nPins/settings: ${selection.configurationDigest}\n${boundaryDescription}\nDocker shares the host kernel, NOT hostile-code isolation. Host browser/proxy are NOT container-isolated.\nReadiness checks may use documented bounded local probes. NO setup, downloads, builds, model calls, target requests or JS imports. This is NOT plan approval. Each automatic preparation action requires another confirmation.`, input.signal ? { signal: input.signal } : undefined)) return { status: 'cancelled' };
  }
  if (input.signal?.aborted) return { status: 'cancelled' };
  const body = { version: 1 as const, source: 'human-ui' as const, ownerUid: ownerUid(), scopeDigest, authorizationDigest, selection,
    acknowledgements: selection.packs.map(p => PACKS[p].acknowledgement), confirmedAt: reused ? saved!.confirmedAt : Date.now() };
  const consent: PackConsent = deepFreeze({ ...body, digest: digest(body) });
  // Narrow reuse does not replace the wider persisted receipt.
  if (!reused) await publishOwnerDocument(root, `packs-${scopeDigest}`, consent);
  issued.add(consent);
  consentTargets.set(consent, { target: config.scope.target.kind === 'local-dir' ? config.scope.target.locator : undefined, cwd: resolve(input.cwd) });
  return { status: 'consented', consent, reused };
}

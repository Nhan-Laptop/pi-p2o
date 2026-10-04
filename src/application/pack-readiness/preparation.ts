import { homedir } from 'node:os';
import { join } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { runFixedProcess } from '../../tools/process.js';
import { deepFreeze } from '../../policy/validation.js';
import { assertPackConsent, assertPreparationOutsideTarget, type PackConsent } from '../onboarding/packs.js';
import { readOwnerDocument } from '../onboarding/storage.js';
import type { OnboardingUI } from '../onboarding/types.js';
import type { PackBlocker } from './readiness.js';

export interface OperatorSetupStep {
  description: string;
  command?: { executable: string; argv: readonly string[] };
  automatic: false;
  requiresSeparateParentApproval: boolean;
}
/** Commands are display-only data, never shell text or executable recipes supplied by a repository. */
export function planOperatorSetup(blockers: readonly PackBlocker[]): readonly OperatorSetupStep[] {
  return deepFreeze(blockers.map(b => {
    if (b.category === 'permission' || b.category === 'docker-daemon') return { description: 'Ask the host operator to provide an already running accessible dedicated-lab Docker daemon. Docker access is privileged. No sudo, group membership, daemon start or global changes are automatic.', command: { executable: '/usr/bin/docker', argv: ['version'] }, automatic: false as const, requiresSeparateParentApproval: false };
    if (b.category === 'image' || b.category === 'layer') return { description: 'Have the parent separately approve installation/build of the EXACT qualified image if needed. Preserve image ID/digest and RootFS layer pins; drift requires fresh qualification and consent, never automatic re-pinning.', command: { executable: '/usr/bin/docker', argv: ['image', 'ls', '--digests', '--no-trunc'] }, automatic: false as const, requiresSeparateParentApproval: true };
    return { description: `Operator must resolve ${b.category}, then repeat actual checks. Engine/Chrome upgrades, downloads, policy changes and new pins require separate parent approval/qualification. Proxy is loopback port 0, passthrough without CA installation.`, automatic: false as const, requiresSeparateParentApproval: true };
  }));
}
export const LOCAL_PREPARATION_ACTIONS = ['create-private-browser-profile-root'] as const;
export type LocalPreparationAction = typeof LOCAL_PREPARATION_ACTIONS[number];
function recipe(action: LocalPreparationAction) {
  if (action !== 'create-private-browser-profile-root') throw new Error('PACK_PREPARE_UNKNOWN_RECIPE');
  return deepFreeze({ executable: '/usr/bin/mkdir', argv: ['-m', '700', '--', join(homedir(), '.p2o', 'browser-profiles')] });
}
export function describeLocalPreparation(action: LocalPreparationAction) { return recipe(action); }
/** Fixed shipped recipe only. No caller argv/path, eval, imports, sudo, chmod, downloads or builds. */
export async function prepareLocalPackAction(input: { consent: PackConsent; action: LocalPreparationAction; ui?: OnboardingUI; signal?: AbortSignal }): Promise<'prepared' | 'cancelled' | 'unsupported'> {
  if (Object.keys(input).some(key => !['consent', 'action', 'ui', 'signal'].includes(key))) throw new Error('PACK_PREPARE_FIXED_RECIPE_ONLY');
  assertPackConsent(input.consent);
  const command = recipe(input.action);
  assertPreparationOutsideTarget(input.consent, command.argv[3]!);
  if (!input.consent.selection.packs.some(p => p === 'browser' || p === 'proxy')) throw new Error('PACK_PREPARE_NOT_SELECTED');
  if (!input.ui) return 'unsupported';
  if (input.signal?.aborted) return 'cancelled';
  if (!await input.ui.confirm('Confirm ONE local TOOL PACK preparation action?', `Create an owner-only private Chrome profile root. Fixed shipped recipe, no shell:\n${JSON.stringify(command)}\nExisting directories are not modified. No privileged/global changes, trust-store install, pulls, builds, downloads, target requests or paid calls. Readiness must be checked again afterward.`, input.signal ? { signal: input.signal } : undefined)) return 'cancelled';
  if (input.signal?.aborted) return 'cancelled';
  assertPackConsent(input.consent);
  const parent = join(homedir(), '.p2o');
  // Existing safe private parent required; never recursively create arbitrary paths or follow links.
  await readOwnerDocument(parent, `packs-${'0'.repeat(64)}`);
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || await realpath(parent) !== parent) throw new Error('PACK_PREPARE_UNSAFE_PARENT');
  const result = await runFixedProcess(command.executable, command.argv, { timeoutMs: 2000, maxOutputBytes: 4096, signal: input.signal });
  if (result.code !== 0) throw new Error('PACK_PREPARE_REFUSED: existing or unavailable destination; operator review required');
  const destination = command.argv[3]!;
  const created = await lstat(destination);
  if (!created.isDirectory() || created.isSymbolicLink() || created.uid !== process.getuid?.() || (created.mode & 0o077) !== 0) throw new Error('PACK_PREPARE_VERIFY_FAILED');
  return 'prepared';
}

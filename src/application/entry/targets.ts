/**
 * Offline target resolution and owner-scope authorization.
 *
 * Type is inferred from the argv shape the interface already classified; nothing here touches the network
 * and nothing here widens scope. A local path is canonicalized and must be an existing directory; a GitHub
 * locator must be exactly the repository root over HTTPS; an HTTP(S) URL must fall inside an owner-approved
 * origin + path prefix. `--target` never authorizes anything: the owner run document does.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { normalizeWebTarget, pathWithin } from '../../policy/index.js';
import type { EntryTarget } from '../../interface/target-entry.js';
import type { EntryDepth } from '../../interface/target-entry.js';
import { entryFail, safeText } from './errors.js';
import { ENTRY_TECHNIQUE_ROUTES, assertOwnerAction, skillsFor, type EntryTechniqueRoute } from './techniques.js';
import type { EntryApprovedTarget, EntryRunBinding } from './types.js';

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export interface ResolvedEntryTarget {
  /** Canonical target identity the human reviews. */
  target: EntryTarget;
  approved: EntryApprovedTarget;
  route: EntryTechniqueRoute;
  mode: 'fixture' | 'assessment';
  skills: string[];
  warnings: string[];
  /** Canonical absolute directory root (local-dir only). */
  localRoot?: string;
  /** Canonical `https://github.com/<owner>/<repo>` (github-repo only). */
  repoUrl?: string;
  /** Canonical normalized URL (http-url only). */
  webUrl?: string;
}

function policyMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  return `${fallback}${message ? `: ${safeText(message, 200)}` : ''}`;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/** Canonical local directory root; the final path component must not be a symlink. */
export function canonicalLocalRoot(raw: string, cwd: string, observer?: { io?(event: { kind: 'stat'; locator: string }): void }): string {
  const expanded = expandHome(raw);
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  observer?.io?.({ kind: 'stat', locator: absolute });
  let stat;
  try { stat = lstatSync(absolute); }
  catch { entryFail('TARGET_NOT_FOUND', `local target ${safeText(absolute, 400)} does not exist or is not readable`); }
  if (stat.isSymbolicLink()) entryFail('TARGET_DENIED', `local target ${safeText(absolute, 400)} is a symlink; pass the canonical directory instead`);
  if (!stat.isDirectory()) entryFail('TARGET_NOT_DIRECTORY', `local target ${safeText(absolute, 400)} exists but is not a directory`);
  let canonical: string;
  try { canonical = realpathSync(absolute); }
  catch { entryFail('TARGET_NOT_FOUND', `local target ${safeText(absolute, 400)} cannot be canonicalized`); }
  if (!canonical) entryFail('TARGET_NOT_FOUND', 'local target could not be canonicalized');
  return canonical;
}

/** Strict `https://github.com/<owner>/<repo>` normalization; never follows redirects or aliases. */
export function normalizeGitHubRepo(value: string): { owner: string; repo: string; url: string } {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { entryFail('TARGET_DENIED', 'GitHub target is not a valid absolute URL'); }
  if (parsed.protocol !== 'https:') entryFail('TARGET_DENIED', 'GitHub targets are cloned over HTTPS only');
  if (parsed.hostname !== 'github.com' || !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/?$/.test(value)) entryFail('TARGET_DENIED', 'GitHub source must be an unambiguous HTTPS github.com repository root');
  if (parsed.port && parsed.port !== '443') entryFail('TARGET_DENIED', 'GitHub target URL must not use a non-default port');
  if (parsed.search) entryFail('TARGET_DENIED', 'GitHub target URL must not carry a query');
  if (parsed.hash) entryFail('TARGET_DENIED', 'GitHub target URL must not carry a fragment');
  const segments = parsed.pathname.split('/').filter(segment => segment.length > 0);
  if (segments.length !== 2) entryFail('TARGET_DENIED', 'GitHub target must be the repository root (https://github.com/<owner>/<repo>), not a subpath');
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/i, '');
  if (!OWNER_PATTERN.test(owner) || owner.includes('..')) entryFail('TARGET_DENIED', 'GitHub owner name is not a valid repository owner');
  if (!REPO_PATTERN.test(repo) || repo === '.' || repo === '..' || repo.includes('..')) entryFail('TARGET_DENIED', 'GitHub repository name is not valid');
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

/** Literal loopback/unspecified hosts; used to gate HTTP(S) targets in fixture mode. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ip = isIP(host);
  if (ip === 4) return host.startsWith('127.') || host === '0.0.0.0';
  if (ip === 6) return host === '::1' || host === '::' || host.startsWith('::ffff:127.');
  return false;
}

function normalizeApprovedWebLocator(locator: string, targetId: string): { origin: string; path: string } {
  let parsed: URL;
  try { parsed = new URL(locator); }
  catch { entryFail('ENTRY_FAILED', `owner target ${targetId} locator is not a valid absolute URL`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') entryFail('ENTRY_FAILED', `owner target ${targetId} locator is not HTTP(S)`);
  if (parsed.username || parsed.password || parsed.hash) entryFail('ENTRY_FAILED', `owner target ${targetId} locator must not carry credentials or a fragment`);
  return { origin: parsed.origin, path: parsed.pathname || '/' };
}

function matchLocal(target: EntryTarget, binding: EntryRunBinding, cwd: string): { approved: EntryApprovedTarget; canonical: string } | undefined {
  const canonical = canonicalLocalRoot(target.raw || target.locator, cwd);
  const raw = expandHome(target.raw || target.locator);
  const resolvedRequest = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  for (const approved of binding.approvedTargets) {
    if (approved.kind !== 'artifact' && approved.kind !== 'lab') continue;
    if (!isAbsolute(approved.locator)) continue;
    const approvedResolved = resolve(approved.locator);
    if (approvedResolved !== resolvedRequest && approvedResolved !== canonical) continue;
    return { approved, canonical };
  }
  return undefined;
}

function matchRepo(target: EntryTarget, binding: EntryRunBinding): { approved: EntryApprovedTarget; repoUrl: string } | undefined {
  const normalized = normalizeGitHubRepo(target.raw || target.locator);
  if (target.locator !== normalized.url) {
    // The interface already canonicalized; a mismatch means the argv carried a subpath/query that the
    // classifier folded away. Refuse instead of silently cloning a wider repository root.
    const again = normalizeGitHubRepo(target.locator);
    if (again.url !== normalized.url) entryFail('TARGET_DENIED', 'GitHub target locator does not match the requested repository');
  }
  for (const approved of binding.approvedTargets) {
    if (approved.kind !== 'artifact') continue;
    let approvedUrl: string;
    try { approvedUrl = normalizeGitHubRepo(approved.locator).url; }
    catch { continue; }
    if (approvedUrl === normalized.url) return { approved, repoUrl: normalized.url };
  }
  return undefined;
}

function matchWeb(target: EntryTarget, binding: EntryRunBinding): { approved: EntryApprovedTarget; webUrl: string; origin: string; path: string } | undefined {
  let normalized;
  try { normalized = normalizeWebTarget(target.raw || target.locator); }
  catch (error) { entryFail('TARGET_DENIED', policyMessage(error, 'HTTP(S) target is not an acceptable absolute URL')); }
  for (const approved of binding.approvedTargets) {
    if (approved.kind !== 'web' && approved.kind !== 'service' && approved.kind !== 'lab') continue;
    let locator: { origin: string; path: string };
    try { locator = normalizeApprovedWebLocator(approved.locator, approved.targetId); }
    catch { continue; }
    if (locator.origin !== normalized.origin) continue;
    if (!pathWithin(normalized.path, locator.path)) continue;
    return { approved, webUrl: normalized.url, origin: normalized.origin, path: normalized.path };
  }
  return undefined;
}

/**
 * Resolve one classified target against the owner-approved run binding. No network, no clone, no copy; a
 * local directory is only stat/realpath-checked here (content is read by the caller's bounded fingerprint).
 */
export function resolveEntryTarget(input: { target: EntryTarget; binding: EntryRunBinding; cwd: string; depth: EntryDepth; observer?: { io?(event: { kind: 'stat'; locator: string }): void } }): ResolvedEntryTarget {
  const { target, binding } = input;
  const warnings: string[] = [];
  if (target.kind === 'local-dir') {
    const match = matchLocal(target, binding, input.cwd);
    if (!match) entryFail('TARGET_DENIED', `local target ${safeText(target.raw, 200)} is not in the owner-approved target list of this run`);
    const route = ENTRY_TECHNIQUE_ROUTES['local-dir'];
    assertOwnerAction(route, match.approved.actions, match.approved.targetId);
    const skills = skillsFor('local-dir', input.depth);
    if (match.approved.digest) warnings.push('owner target pins a content digest; it is verified against the bounded read-only fingerprint');
    if (match.approved.revision) warnings.push('owner target pins a revision label; it is verified against the observed fingerprint');
    return {
      target: { kind: 'local-dir', raw: target.raw, locator: match.canonical },
      approved: match.approved, route, mode: binding.mode, skills, warnings, localRoot: match.canonical,
    };
  }
  if (target.kind === 'github-repo') {
    const match = matchRepo(target, binding);
    if (!match) entryFail('TARGET_DENIED', `GitHub repository ${safeText(target.raw, 200)} is not in the owner-approved target list of this run`);
    const route = ENTRY_TECHNIQUE_ROUTES['github-repo'];
    if (match.approved.revision && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(match.approved.revision)) entryFail('TARGET_DENIED', 'owner GitHub revision must be a full immutable commit');
    if (match.approved.digest && !/^[a-f0-9]{64}$/.test(match.approved.digest)) entryFail('TARGET_DENIED', 'owner source digest must be SHA-256');
    assertOwnerAction(route, match.approved.actions, match.approved.targetId);
    warnings.push('the resolved commit is observed after approval, when the bounded clone runs; preparation itself makes no network request');
    if (match.approved.revision) warnings.push('owner target pins a revision (commit); a clone resolving another commit is refused');
    return {
      target: { kind: 'github-repo', raw: target.raw, locator: match.repoUrl },
      approved: match.approved, route, mode: binding.mode, skills: skillsFor('github-repo', input.depth), warnings, repoUrl: match.repoUrl,
    };
  }
  const match = matchWeb(target, binding);
  if (!match) entryFail('TARGET_DENIED', `HTTP(S) target ${safeText(target.raw, 200)} is outside every owner-approved origin and path prefix of this run`);
  const route = ENTRY_TECHNIQUE_ROUTES['http-url'];
  assertOwnerAction(route, match.approved.actions, match.approved.targetId);
  if (binding.mode === 'fixture' && !isLoopbackHost(new URL(match.origin).hostname)) {
    entryFail('TARGET_DENIED', 'fixture runs may only contact owner-approved loopback origins; a non-loopback HTTP(S) target needs an assessment-mode owner document');
  }
  if (binding.mode === 'assessment' && isLoopbackHost(new URL(match.origin).hostname)) {
    warnings.push('assessment run against an owner-approved loopback origin; scope is exact-origin only');
  }
  return {
    target: { kind: 'http-url', raw: target.raw, locator: match.webUrl },
    approved: match.approved, route, mode: binding.mode, skills: skillsFor('http-url', input.depth), warnings, webUrl: match.webUrl,
  };
}

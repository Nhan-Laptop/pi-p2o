import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { invariant } from './errors.js';
import type { Action, Decision, NormalizedWebTarget } from './types.js';

/** Refuse parser-ambiguous inputs instead of trusting WHATWG's dot-segment cleanup. */
export function normalizeWebTarget(value: string): NormalizedWebTarget {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= 8192, 'INVALID_INPUT', 'Invalid URL size');
  invariant(!/[\s\u0000-\u0020\u007f\\]/u.test(value), 'INVALID_INPUT', 'URL contains whitespace, control or backslash');
  invariant(/^https?:\/\//i.test(value), 'TARGET_DENIED', 'Only absolute HTTP(S) URLs are supported');
  const rawPath = value.replace(/^https?:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0]!;
  invariant(!/%(?:2f|5c|2e|25)/i.test(rawPath), 'TARGET_DENIED', 'Encoded separators, dot segments or nested escapes are not supported');
  invariant(!rawPath.split('/').some(p => p === '.' || p === '..'), 'TARGET_DENIED', 'Dot segments are not supported');
  let canonicalPath: string;
  try { canonicalPath = decodeURIComponent(rawPath || '/').normalize('NFKC').replace(/\/+/g, '/'); } catch { invariant(false, 'INVALID_INPUT', 'Malformed path encoding'); }
  invariant(!/[\u0000-\u0020\u007f\\%;?#]/.test(canonicalPath) && !canonicalPath.split('/').some(p => p === '.' || p === '..'), 'TARGET_DENIED', 'Ambiguous decoded path or matrix parameters');
  let url: URL;
  try { url = new URL(value); } catch { invariant(false, 'INVALID_INPUT', 'Invalid URL'); }
  invariant(!url.username && !url.password, 'ACCOUNT_DENIED', 'URL credentials are forbidden');
  invariant(url.protocol === 'http:' || url.protocol === 'https:', 'TARGET_DENIED', 'Unsupported protocol');
  invariant(!url.hostname.includes('%'), 'TARGET_DENIED', 'Zone identifiers are forbidden');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  invariant(hostname.length > 0 && (isIP(hostname) > 0 || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)), 'TARGET_DENIED', 'Invalid hostname');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  invariant(Number.isInteger(port) && port > 0 && port <= 65535, 'TARGET_DENIED', 'Invalid port');
  // Dispatch the canonical path too: %61dmin and duplicate/compatibility separators
  // cannot pass a check on one representation and reach a different server path.
  url.pathname = canonicalPath;
  url.pathname = url.pathname.replace(/%[0-9a-f]{2}/gi, p => p.toUpperCase());
  invariant(url.href.length <= 8192, 'INVALID_INPUT', 'Canonical URL exceeds byte limit');
  return Object.freeze({ url: url.href, origin: url.origin, protocol: url.protocol, hostname, port, path: url.pathname });
}
export function normalizeOrigin(value: string): string {
  const n = normalizeWebTarget(value);
  const u = new URL(n.url);
  invariant(n.path === '/' && !u.search && !value.includes('#'), 'INVALID_INPUT', 'Origin must not include a path, query or fragment');
  return n.origin;
}
export function normalizePathPrefix(value: string): string {
  invariant(typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[?#]/.test(value), 'INVALID_INPUT', 'Invalid path prefix');
  const p = normalizeWebTarget(`https://policy.invalid${value}`).path;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}
export function pathWithin(path: string, prefix: string): boolean {
  return prefix === '/' || path === prefix || path.startsWith(`${prefix}/`);
}

// ---------------------------------------------------------------------------------------------
// [T2] Authenticated target access: policy-side credential binding.
//
// A scope carries no credential material (see `ApprovedAccount`). What the policy layer can and must
// prove at dispatch time is the *binding*: which approved account may act on which target, with which
// action, inside which authorization window. Resolution of the secret itself happens behind the
// credential-owning boundary in `src/application/authority.ts`; a denial here never issues a request.
// ---------------------------------------------------------------------------------------------
export type CredentialDenialCode =
  | 'CREDENTIAL_UNKNOWN' | 'CREDENTIAL_EXPIRED' | 'CREDENTIAL_MISSING' | 'CREDENTIAL_TARGET_MISMATCH'
  | 'CREDENTIAL_ACTION_DENIED' | 'CREDENTIAL_ANONYMOUS' | 'CREDENTIAL_VERSION_MISMATCH'
  | 'CREDENTIAL_BOUNDARY_UNAVAILABLE';

/** Explicit fail-closed denial. Carries the approved account identity, never a secret. */
export class CredentialDeniedError extends Error {
  constructor(readonly code: CredentialDenialCode, readonly accountId: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CredentialDeniedError';
  }
}

export const CREDENTIAL_REF_DOMAIN = 'p2o-credential-ref:v1';
const accountIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

/** Stable, domain-separated digest reference for a credential value or identity. */
export function credentialRef(...parts: string[]): string {
  return `sha256:${createHash('sha256').update([CREDENTIAL_REF_DOMAIN, ...parts].join('\u0000')).digest('hex')}`;
}

/**
 * Namespaced per-account slot. The worker cannot alias a slot onto another account's material:
 * only the exact approved account id shape resolves, and every lookup is namespaced by that id.
 */
export function credentialAccountSlot(accountId: string): string {
  if (typeof accountId !== 'string' || !accountIdPattern.test(accountId)) {
    throw new CredentialDeniedError('CREDENTIAL_UNKNOWN', typeof accountId === 'string' ? accountId.slice(0, 128) : '', 'account identity is not a bounded approved account id');
  }
  return `account:${accountId}`;
}

/** The approved binding established by a policy decision, with no credential material. */
export interface ApprovedCredentialAccount {
  readonly accountId: string;
  readonly targetId: string;
  readonly action: Action;
  readonly expiresAt: string;
}

/**
 * Re-prove the account/target/action/expiry binding from the *policy decision* (never from worker
 * input) before any credential is resolved. Fails closed with an explicit credential denial code.
 */
export function assertCredentialAccount(decision: Pick<Decision, 'account' | 'target' | 'action'>, at: string): ApprovedCredentialAccount {
  const account = decision.account;
  if (!account) throw new CredentialDeniedError('CREDENTIAL_UNKNOWN', '', 'policy decision carries no approved account');
  credentialAccountSlot(account.id); // malformed/aliased identities deny before any lookup
  if (account.kind !== 'credential') throw new CredentialDeniedError('CREDENTIAL_ANONYMOUS', account.id, 'anonymous accounts carry no credential material');
  const target = decision.target;
  if (!target) throw new CredentialDeniedError('CREDENTIAL_TARGET_MISMATCH', account.id, 'policy decision carries no approved target');
  if (!account.targetIds.includes(target.id)) throw new CredentialDeniedError('CREDENTIAL_TARGET_MISMATCH', account.id, `account is not approved for target ${target.id}`);
  if (!target.accounts.includes(account.id)) throw new CredentialDeniedError('CREDENTIAL_TARGET_MISMATCH', account.id, `target does not list account ${account.id}`);
  if (!account.actions.includes(decision.action)) throw new CredentialDeniedError('CREDENTIAL_ACTION_DENIED', account.id, `account is not approved for action ${decision.action}`);
  if (!(Date.parse(account.expiresAt) > Date.parse(at))) throw new CredentialDeniedError('CREDENTIAL_EXPIRED', account.id, 'approved account has expired');
  return Object.freeze({ accountId: account.id, targetId: target.id, action: decision.action, expiresAt: account.expiresAt });
}

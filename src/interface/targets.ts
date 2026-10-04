/**
 * Pure target classification for `/p2o --target …`.
 *
 * No filesystem access, no network, no shell. A scheme-less value is only a *candidate* local directory; the
 * entry port validates existence and type. Bare hosts/IPs are refused instead of guessing `https://`, so a
 * typo can never fabricate an intent the user did not state.
 */
import { InterfaceError } from './types.js';
import type { EntryTarget } from './target-entry.js';

export const ACCEPTED_TARGET_FORMS =
  'accepted targets: an existing local directory, an https GitHub repository (https://github.com/<owner>/<repo>), or an absolute http(s) URL';

const MAX_TARGET = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:/;
const BARE_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?::\d+)?(?:\/.*)?$/;

function refuse(detail: string): InterfaceError {
  return new InterfaceError('UNSUPPORTED_TARGET', `${detail}; ${ACCEPTED_TARGET_FORMS}`);
}

/** Classify one raw `--target` value. Never touches the target. */
export function classifyTargetSyntax(raw: string): EntryTarget {
  const value = raw.trim();
  if (!value) throw new InterfaceError('MISSING_TARGET', `--target requires a value; ${ACCEPTED_TARGET_FORMS}`);
  if (value.length > MAX_TARGET) throw refuse('target is longer than 4096 characters');
  if (CONTROL.test(value)) throw refuse('target contains control characters');
  if (SCP_LIKE.test(value)) throw refuse('ssh/scp-style repository locators are not accepted');

  const scheme = SCHEME.exec(value);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== 'http' && name !== 'https') throw refuse(`target scheme "${name}://" is not accepted`);
    let url: URL;
    try { url = new URL(value); }
    catch { throw refuse('target is not a valid absolute URL'); }
    if (url.username || url.password) throw refuse('target URL must not embed credentials');
    if (!url.hostname) throw refuse('target URL must include a host');
    if (name === 'https' && (url.hostname === 'github.com' || url.hostname === 'www.github.com')) {
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length >= 2 && segments[0] !== '.' && segments[1] !== '.') {
        const owner = segments[0];
        const repo = segments[1].replace(/\.git$/i, '');
        if (owner && repo) return { kind: 'github-repo', raw: value, locator: `https://github.com/${owner}/${repo}` };
      }
    }
    return { kind: 'http-url', raw: value, locator: url.href };
  }

  if (value.startsWith('.') || value.startsWith('/') || value.startsWith('~')) {
    return { kind: 'local-dir', raw: value, locator: value };
  }
  if (BARE_HOST.test(value)) {
    throw refuse('a bare domain or IP address is not accepted without a scheme or path prefix');
  }
  return { kind: 'local-dir', raw: value, locator: value };
}

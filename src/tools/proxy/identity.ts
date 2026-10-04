import { readFileSync } from 'node:fs';
import { invariant } from '../../policy/errors.js';
import { digest } from '../../policy/validation.js';
import { sha256 } from '../redaction.js';
import type { ProxyIdentityEvidence } from '../types.js';

export const PROXY_CAPTURE_MODE = 'passthrough-no-mitm' as const;
export const PROXY_TRANSPORT = 'loopback-http-capture-proxy' as const;
/** Files whose bytes define the capture pack's identity: the proxy transport plus every pack module. */
const MODULES = ['../browser-proxy', './identity', './store', './gate', './replay', './pack', '../proxy'];
let cached: ProxyIdentityEvidence | undefined;

/**
 * The proxy identity is recomputed from the installed module bytes (never from a file the worker can write),
 * exactly like the pinned browser identity. A run that observed one identity digest can prove a later
 * capture session was produced by the same code: the digest is recorded in every session's evidence.
 */
export function proxyIdentity(): ProxyIdentityEvidence {
  if (cached) return cached;
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const identities: [string, string][] = [];
  for (const name of MODULES) {
    try { identities.push([name, sha256(readFileSync(new URL(`${name}${extension}`, import.meta.url)))]); }
    catch { invariant(false, 'UNAVAILABLE', 'Capture pack identity could not be re-hashed from the installed modules'); }
  }
  const implementationDigest = digest(identities);
  cached = Object.freeze({
    mode: PROXY_CAPTURE_MODE, transport: PROXY_TRANSPORT, mitm: 'none' as const,
    implementationDigest, identityDigest: digest({ mode: PROXY_CAPTURE_MODE, transport: PROXY_TRANSPORT, mitm: 'none', implementationDigest }),
  });
  return cached;
}

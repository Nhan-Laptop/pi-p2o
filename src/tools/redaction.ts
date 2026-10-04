import { createHash } from 'node:crypto';
import { invariant } from '../policy/errors.js';

export interface Redactor { text(value: string): string; value(value: unknown): unknown; register(secrets: readonly string[]): void }
const sensitiveKey = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|credential|session|csrf)/i;
export function createRedactor(initialSecrets: readonly string[] = []): Redactor {
  const secrets = new Set<string>();
  const register = (values: readonly string[]) => {
    for (const value of values) {
      invariant(typeof value === 'string' && value.length > 0 && value.length <= 16384, 'INVALID_INPUT', 'Invalid secret for redaction');
      secrets.add(value);
      secrets.add(encodeURIComponent(value));
      secrets.add(Buffer.from(value).toString('base64'));
    }
  };
  register(initialSecrets);
  const text = (value: string): string => {
    let result = value;
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
    return result
      .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[REDACTED PRIVATE KEY]')
      .replace(/\b(?:Bearer|Basic)\s+[a-zA-Z0-9+\/_.=:-]+/gi, '[REDACTED AUTH]')
      .replace(/((?:password|passwd|secret|token|api[-_]?key|session|csrf)["']?\s*[:=]\s*["']?)[^\s"'&,;<>}]+/gi, '$1[REDACTED]')
      .replace(/([?&](?:password|secret|token|key|session|code)=)[^&#\s]*/gi, '$1[REDACTED]');
  };
  const scrub = (v: unknown, depth = 0): unknown => {
    invariant(depth < 32, 'OUTPUT_LIMIT', 'Redaction nesting limit exceeded');
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(x => scrub(x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), sensitiveKey.test(k) ? '[REDACTED]' : scrub(x, depth + 1)]));
    return v;
  };
  return Object.freeze({ text, value: scrub, register });
}
export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

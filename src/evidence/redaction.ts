import { canonicalJson, digestJson, type JsonValue } from '../contracts/index.js';
import { requireEvidence } from './common.js';

export interface EvidenceRedactor {
  readonly policyDigest: string;
  text(value: string): string;
  json<T>(value: T): T;
  artifact(bytes: Uint8Array, mediaType: string): Buffer;
}
const sensitiveKey = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|.*[_-]secret|access[_-]?token|refresh[_-]?token|token|api[_-]?key|private[_-]?key|credentials?|session[_-]?(?:id|key)|csrf[_-]?token)$/i;
const mediaTypes = new Set(['application/json', 'text/plain', 'text/javascript', 'application/javascript', 'text/typescript', 'text/html', 'text/markdown', 'text/csv']);
export function createEvidenceRedactor(knownSecrets: readonly string[] = []): EvidenceRedactor {
  requireEvidence(knownSecrets.length <= 1024 && knownSecrets.every(v => typeof v === 'string' && v.length > 0 && v.length <= 16_384), 'redaction-config', 'Known secrets exceed redaction bounds');
  const secrets = [...new Set(knownSecrets.flatMap(v => [v, encodeURIComponent(v), Buffer.from(v).toString('base64')]))].sort((a, b) => b.length - a.length);
  const text = (value: string): string => {
    let out = value;
    for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
    return out
      .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[REDACTED PRIVATE KEY]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+\/_.=:-]+/gi, '[REDACTED AUTH]')
      .replace(/(\b(?:password|passwd|secret|token|api[-_]?key|cookie|session[-_]?id)\s*["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
      .replace(/([?&](?:password|secret|token|key|session|code)=)[^&#\s]*/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED KEY]');
  };
  function json<T>(input: T): T {
    canonicalJson(input); // Do not invoke getters, toJSON, or parse arbitrary objects.
    function walk(value: JsonValue): JsonValue {
      if (typeof value === 'string') return text(value);
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [text(key), sensitiveKey.test(key) ? '[REDACTED]' : walk(child)]));
      return value;
    }
    return walk(input as JsonValue) as T;
  }
  return Object.freeze({
    // Do not export hashes of individual secrets. Protect this policy identity alongside the vault.
    policyDigest: digestJson({ version: 1, secretSet: secrets }), text, json,
    artifact(bytes: Uint8Array, mediaType: string): Buffer {
      requireEvidence(mediaTypes.has(mediaType), 'media-type', 'Only supported textual artifacts can be redacted and admitted');
      let decoded: string;
      try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error('Artifact is not valid UTF-8'); }
      requireEvidence(!decoded.includes('\u0000') && !/^\uFEFF/.test(decoded), 'artifact-encoding', 'Binary, BOM, or ambiguous text artifacts are not admitted');
      if (mediaType === 'application/json') {
        let data: unknown;
        try { data = JSON.parse(decoded); } catch { throw new Error('Artifact is not valid JSON'); }
        return Buffer.from(canonicalJson(json(data)));
      }
      return Buffer.from(text(decoded));
    },
  });
}

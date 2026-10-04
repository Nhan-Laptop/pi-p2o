import { canonicalJson } from '../contracts/validation.js';
import type { JsonObject, JsonValue } from '../contracts/types.js';

const sensitive = /^(?:authorization|authorizationRef|reference|authorizedBy|password|passwd|secret|token|leaseToken|claimToken|apiKey|api_key|cookie|cookies|credentials|headers|body|raw|stdout|stderr|workspace|locator|path|environment|env|lastError)$/i;
const containers = new Set(['payload', 'requestedRuntime', 'observedRuntime', 'selection', 'capabilities', 'processIdentity', 'delta', 'usage', 'reasons']);
const machineStrings = new Set(['eventId', 'runId', 'taskId', 'attemptId', 'resultId', 'packetId', 'findingId', 'coverageId', 'evidenceId', 'evidenceIds', 'targetId', 'type', 'state', 'from', 'to', 'lifecycleState', 'packetState', 'outcome', 'contract', 'classification', 'kind', 'basis', 'verification', 'attestation', 'adapter', 'provider', 'model', 'thinking', 'code']);
const dates = new Set(['occurredAt', 'expiresAt', 'observedAt']);
const digests = new Set(['digest', 'acceptedDigest', 'configurationDigest']);
const numeric = new Set(['sequence', 'schemaVersion', 'generation', 'byteLength', 'requests', 'bytes', 'toolCalls', 'tokens', 'costUsd', 'pid']);
const boolean = new Set(['duplicate', 'terminationConfirmed', 'ownsLifecycle', 'canHardStop', 'canResume', 'streamsEvents', 'attestsRuntime']);
const credentialMarker = /(?:bearer|password|secret|token|cookie|api[_-]?key|sk[-_][a-z0-9]{8})/i;

/** Conservative allowlist: arbitrary prose, URLs, paths and unknown payload keys do not leave the DB. */
export function redactForExport(input: JsonObject): JsonObject {
  canonicalJson(input); // Reject accessors/cycles/non-JSON before traversing.
  function redact(value: JsonValue, key: string): JsonValue | undefined {
    if (sensitive.test(key)) return '[REDACTED]';
    if (Array.isArray(value)) {
      if (key === 'evidenceIds') return value.map(v => redact(v, 'evidenceId') ?? '[REDACTED]');
      if (key === 'reasons') return value.map(v => object(v));
      return undefined;
    }
    if (value !== null && typeof value === 'object') return containers.has(key) ? object(value) : undefined;
    if (typeof value === 'string') {
      if (digests.has(key) && /^[a-f0-9]{64}$/.test(value)) return value;
      if (dates.has(key) && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) return value;
      if (machineStrings.has(key) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !credentialMarker.test(value)) return value;
      return machineStrings.has(key) ? '[REDACTED]' : undefined;
    }
    if (typeof value === 'number' && numeric.has(key)) return value;
    if (typeof value === 'boolean' && boolean.has(key)) return value;
    return undefined;
  }
  function object(value: JsonValue): JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { redactedFieldCount: 1 };
    const result: JsonObject = {};
    let omitted = 0;
    for (const [key, child] of Object.entries(value)) {
      const redacted = redact(child, key);
      if (redacted === undefined) omitted++;
      else result[key] = redacted;
    }
    if (omitted) result.redactedFieldCount = omitted;
    return result;
  }
  return object(input);
}

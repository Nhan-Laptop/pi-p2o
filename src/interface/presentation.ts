import type { Events, Preflight, RecordPage, Report, Snapshot } from './types.js';

export const MAX_TEXT_BYTES = 4096;
export const MAX_OUTPUT_BYTES = 48 * 1024;
const REDACTED = '[redacted]';
const forbiddenKey = /(?:^token$|^auth$|^env$|secret|password|credential|authorization|cookie|api.?key|access.?token|refresh.?token|owner.?token|lease.?token|headers|environment|sessionFile|controlDir|locator|workspace|raw|payload|prompt|argv|private|logTail|stdout|stderr)/i;

/** Defense in depth, not universal DLP: raw credentials/artifacts are excluded by projection. */
export function safeText(value: unknown, bytes = MAX_TEXT_BYTES): string {
  if (typeof value !== 'string') return '';
  const redacted = value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[-A-Za-z0-9._~+/=]+/gi, REDACTED)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, REDACTED)
    .replace(/\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n]+)/gi, REDACTED)
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|key|api_key|password|secret|auth)=)[^&#\s]*/gi, '$1[redacted]')
    // Strip terminal control sequences as well as HTML rendering hazards in non-browser consumers.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const buffer = Buffer.from(redacted);
  if (buffer.length <= bytes) return redacted;
  return buffer.subarray(0, Math.max(0, bytes - 32)).toString('utf8').replace(/\uFFFD$/, '') + '\n[display truncated]';
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || !value) return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && 'value' in d ? d.value : undefined;
}
function pick(value: unknown, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const v = field(value, key);
    if (v !== undefined) result[key] = publicValue(v);
  }
  return result;
}
/** Bounded, accessor-free, credential-key-denying public JSON. Never invoke toJSON. */
export function publicValue(value: unknown): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): unknown {
    if (++nodes > 3000 || depth > 8) return '[display truncated]';
    if (typeof v === 'string') return safeText(v);
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'object' || !v) return undefined;
    if (seen.has(v)) return '[cycle omitted]';
    seen.add(v);
    let output: unknown;
    if (Array.isArray(v)) {
      output = v.slice(0, 100).map((_, i) => visit(field(v, String(i)), depth + 1));
    } else {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(v).slice(0, 100)) {
        if (forbiddenKey.test(key) || ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key)) continue;
        const raw = field(v, key);
        if (raw !== undefined) result[safeText(key, 100)] = visit(raw, depth + 1);
      }
      output = result;
    }
    seen.delete(v);
    return output;
  }
  return visit(value, 0);
}

export function projectTask(value: unknown): Record<string, unknown> {
  return pick(value, ['taskId', 'runId', 'parentTaskId', 'dependencyTaskIds', 'depth', 'inputRevision',
    'question', 'skills', 'lifecycleState', 'packetState', 'budgets', 'requestedRuntime']);
}
export function projectEvidence(value: unknown): Record<string, unknown> {
  const result = pick(value, ['evidenceId', 'runId', 'taskId', 'attemptId', 'kind', 'classification',
    'digest', 'mediaType', 'byteLength', 'redacted', 'test', 'analysis']);
  if (field(value, 'redacted') === true) result.summary = safeText(field(value, 'summary'));
  result.provenance = pick(field(value, 'provenance'), ['collectorId', 'trust', 'method', 'collectedAt', 'tool', 'inputDigests', 'originalEnvironment', 'modifications']);
  return result;
}
function selectionComparison(attempt: unknown): unknown {
  const requested = field(field(attempt, 'requestedRuntime'), 'selection');
  const observed = field(field(attempt, 'observedRuntime'), 'selection');
  if (!requested || !observed) return { state: 'unavailable', fields: [] };
  const fields = ['provider', 'model', 'thinking'].filter(k => field(requested, k) !== field(observed, k));
  return { state: fields.length ? 'mismatch' : 'match', fields, qualification: 'Comparison is not provider authentication or finding verification.' };
}
export function projectSnapshot(snapshot: Snapshot): Record<string, unknown> {
  return {
    mode: snapshot.mode,
    qualification: 'Process completion, packet acceptance and finding verification are independent. Coverage can be incomplete.',
    run: pick(snapshot.run, ['runId', 'state', 'createdAt', 'budgets', 'requestedRuntime']),
    process: {
      tasks: snapshot.tasks.slice(0, 100).map(projectTask),
      attempts: snapshot.attempts.slice(0, 100).map(a => ({
        ...pick(a, ['attemptId', 'taskId', 'sequence', 'lifecycleState', 'heartbeatAt', 'deadlineAt', 'requestedRuntime', 'exit', 'usage']),
        observedRuntime: field(a, 'observedRuntime') === undefined
          ? { attestation: 'unavailable', selection: null }
          : pick(field(a, 'observedRuntime'), ['adapter', 'selection', 'capabilities', 'attestation', 'observedAt', 'receiptEvidenceIds']),
        selectionComparison: selectionComparison(a),
      })),
    },
    packets: snapshot.packets.slice(0, 100).map(p => pick(p, ['resultId', 'packetId', 'taskId', 'attemptId', 'status', 'outcome', 'digest', 'decision', 'admittedAt'])),
    findings: snapshot.findings.slice(0, 100).map(f => pick(f, ['findingId', 'taskId', 'title', 'claim', 'classification', 'state', 'evidenceIds', 'negativeControlEvidenceIds', 'limitations', 'impact', 'verifier'])),
    coverage: snapshot.coverage.slice(0, 100).map(c => pick(c, ['coverageId', 'taskId', 'surfaceId', 'actorId', 'question', 'state', 'basis', 'evidenceIds', 'reason'])),
    failures: snapshot.failures.slice(0, 100).map(f => pick(f, ['code', 'message', 'taskId', 'attemptId', 'state'])),
    counts: { tasks: snapshot.tasks.length, attempts: snapshot.attempts.length, packets: snapshot.packets.length,
      findings: snapshot.findings.length, coverage: snapshot.coverage.length, failures: snapshot.failures.length },
    truncated: [snapshot.tasks, snapshot.attempts, snapshot.packets, snapshot.findings, snapshot.coverage, snapshot.failures].some(a => a.length > 100),
  };
}
export function projectPage(page: RecordPage, kind: 'tasks' | 'evidence'): unknown {
  return { ...pick(page, ['total', 'offset']), items: page.items.slice(0, 100).map(kind === 'tasks' ? projectTask : projectEvidence), truncated: page.items.length > 100 };
}
export function projectEvents(page: Events): unknown {
  return {
    items: page.items.slice(0, 100).map(e => ({
      ...pick(e, ['sequence', 'eventId', 'occurredAt', 'type', 'taskId', 'attemptId']),
      ...(e.display?.redacted === true ? { display: { kind: e.display.kind, text: safeText(e.display.text) } } : {}),
    })),
    nextSequence: page.nextSequence,
    gap: page.gap || page.items.length > 100,
  };
}
export function projectPreflight(p: Preflight): unknown {
  return publicValue(p);
}
export function projectReport(report: Report): unknown {
  return { format: report.format, content: publicValue(report.content), ...(report.modelBudget ? { modelBudget: publicValue(report.modelBudget) } : {}) };
}
export function boundedOutput(value: unknown, maxBytes = MAX_OUTPUT_BYTES): { value: unknown; text: string; truncated: boolean } {
  const safe = publicValue(value);
  const text = JSON.stringify(safe, null, 2) ?? 'null';
  if (Buffer.byteLength(text) <= maxBytes) return { value: safe, text, truncated: false };
  const notice = `Display limit reached (${Math.floor(maxBytes / 1024)}KiB). Use paginated p2o_tasks/p2o_evidence/p2o_events; durable data was not changed.`;
  let previewBytes = Math.max(0, maxBytes - 1024);
  let bounded: { truncated: true; notice: string; preview: string };
  let serialized: string;
  do {
    bounded = { truncated: true, notice, preview: safeText(text, previewBytes) };
    serialized = JSON.stringify(bounded);
    previewBytes = Math.floor(previewBytes / 2);
  } while (Buffer.byteLength(serialized) > maxBytes && previewBytes > 0);
  return { value: bounded, text: serialized, truncated: true };
}
export function publicError(error: unknown): Error {
  const name = typeof field(error, 'code') === 'string' ? safeText(field(error, 'code'), 80) : 'INTERFACE_ERROR';
  return new Error(`${name}: ${safeText(error instanceof Error ? error.message : 'Operation failed', 1024)}`);
}

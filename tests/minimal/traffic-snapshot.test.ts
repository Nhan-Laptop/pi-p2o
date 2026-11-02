import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { indexRecords, type AssessmentRecord } from '../../src/records.js';
import type { ReproductionStep } from '../../src/case-types.js';
import {
  FROZEN_BODY_BYTES, FROZEN_ENTRY_BYTES, FROZEN_ENTRY_LIMIT, FROZEN_HEADER_LIMIT, FROZEN_HEADER_VALUE_BYTES, TRAFFIC_SNAPSHOT_FORMAT,
  evidenceVersionOf, parseFrozenEntries, resolveTrafficBinding, snapshotByteLength, snapshotJson, storedTrafficBinding, verifyTrafficEvidence,
  type FrozenEntry, type TrafficRef,
} from '../../src/traffic-snapshot.js';

/** W-Y (A): the frozen traffic snapshot is pure data. Hermetic: no sandbox, no store, no target. */
const ARTIFACT_A = 'artifact-00000000-0000-4000-8000-000000000001';
const ARTIFACT_B = 'artifact-00000000-0000-4000-8000-000000000002';
const ARTIFACT_C = 'artifact-00000000-0000-4000-8000-000000000003';
const hex = (value: string) => createHash('sha256').update(value).digest('hex');
const mask = (value: string) => value.replaceAll('s3cret', '[redacted]');
const harEntry = (url: string, over: Record<string, unknown> = {}) => ({
  request: { method: 'GET', url, headers: [{ name: 'accept', value: 'text/html' }, { name: 'cookie', value: 'session=s3cret' }] },
  response: { status: 200, headers: [{ name: 'content-type', value: 'text/html' }], content: { mimeType: 'text/html', text: '<html>fixture</html>' } },
  ...over,
});
const har = (entries: unknown[]) => JSON.stringify({ log: { version: '1.2', entries } });
const ref = (snapshotRef: string, over: Partial<TrafficRef> = {}): TrafficRef => ({ role: 'proof', position: 1, snapshotRef, sha256: 'a'.repeat(64), ...over });
const step = (refId: string, role: ReproductionStep['role'], snapshotRef?: string): ReproductionStep => ({ ref: refId, role, ...(snapshotRef === undefined ? {} : { snapshotRef }) });
/** One imported HAR as the extension records it: an owner note per snapshot artifact, never a model-supplied value. */
const snapshotNote = (snapshots: Array<{ snapshotRef: string; sha256: string }>, over: Partial<AssessmentRecord> = {}): AssessmentRecord => ({
  id: randomUUID(), runId: 'run-1', at: '2030-01-01T00:00:00.000Z', by: 'owner', kind: 'note', text: 'seeded frozen traffic snapshot',
  data: { trafficSnapshot: { format: TRAFFIC_SNAPSHOT_FORMAT, sourceArtifact: ARTIFACT_A, sourceSha256: 'a'.repeat(64),
    snapshots: snapshots.map((snapshot, index) => ({ position: index + 1, snapshotRef: snapshot.snapshotRef, sha256: snapshot.sha256, method: 'GET', url: `https://fixture.test/${index + 1}`, status: 200, requestSha256: 'b'.repeat(64), responseSha256: 'c'.repeat(64) })) } },
  ...over,
});
const ratingNote = (trafficRefs: TrafficRef[], over: Partial<AssessmentRecord> = {}, evidenceVersion = evidenceVersionOf(trafficRefs)): AssessmentRecord => ({
  id: randomUUID(), runId: 'run-1', at: '2030-01-02T00:00:00.000Z', by: 'owner', kind: 'note', text: 'rated case',
  data: { caseRating: { caseId: 'case-1', caseRevision: 2, evidenceVersion, trafficRefs } }, ...over,
});
const index = (rows: AssessmentRecord[]) => indexRecords(rows, 'run-1');

describe('frozen traffic snapshot', () => {
  it('parses a HAR into ordered frozen entries and redacts before hashing', () => {
    const parsed = parseFrozenEntries(har([harEntry('https://fixture.test/a?token=s3cret'), harEntry('https://fixture.test/b', { request: { method: 'POST', url: 'https://fixture.test/b', headers: [], postData: { mimeType: 'application/json', text: '{"password":"s3cret"}' } } })]), mask);
    expect(parsed.omitted).toBe(0); expect(parsed.warnings).toEqual([]);
    expect(parsed.entries.map(entry => [entry.position, entry.method, entry.url, entry.status])).toEqual([[1, 'GET', 'https://fixture.test/a?token=[redacted]', 200], [2, 'POST', 'https://fixture.test/b', 200]]);
    const [first, second] = parsed.entries;
    expect(Object.keys(first.request.headers)).toEqual(['accept', 'cookie']);
    expect(first.request.headers.cookie).toBe('[REDACTED]'); // credential header: masked by name, not only by value pattern
    expect(first.response.headers['content-type']).toBe('text/html');
    // The hash covers the redacted bytes: it equals the digest of the retained body and never the raw secret's digest.
    expect(second.request.body).toBe('{"password":"[redacted]"}');
    expect(second.request.bodySha256).toBe(hex(second.request.body!)); expect(second.request.bodySha256).not.toBe(hex('{"password":"s3cret"}'));
    expect(second.request.bodyBytes).toBe(Buffer.byteLength(second.request.body!)); expect(second.request.bodyTruncated).toBe(false);
    for (const value of [first.requestSha256, first.responseSha256, first.request.headersSha256]) expect(value).toMatch(/^[a-f0-9]{64}$/);
    // The canonical snapshot bytes are insertion-order independent and stay inside the artifact entry bound.
    const reordered: FrozenEntry = { response: first.response, request: first.request, responseSha256: first.responseSha256, requestSha256: first.requestSha256, status: first.status, url: first.url, method: first.method, position: first.position };
    expect(snapshotJson(reordered)).toBe(snapshotJson(first)); expect(snapshotJson(first)).toContain(`"format":"${TRAFFIC_SNAPSHOT_FORMAT}"`);
    expect(snapshotByteLength(first)).toBe(Buffer.byteLength(snapshotJson(first))); expect(snapshotByteLength(first)).toBeLessThanOrEqual(FROZEN_ENTRY_BYTES);
  });

  it('masks credential headers by name before hashing, even where value redaction cannot see them', () => {
    const parsed = parseFrozenEntries(har([harEntry('https://fixture.test/auth', {
      request: { method: 'GET', url: 'https://fixture.test/auth', headers: [
        { name: 'Cookie', value: 'sid=SECRET-SESSION-ABC' }, { name: 'X-Api-Key', value: 'sk-SECRET-API-KEY' },
        { name: 'X-Auth-Token', value: 'SECRET-X-AUTH' }, { name: 'Authorization', value: 'Bearer SECRET-TOKEN-XYZ' }, { name: 'X-Trace', value: 'visible-trace' },
      ] },
      response: { status: 200, headers: [{ name: 'Set-Cookie', value: 'sid=SECRET-ROTATED; HttpOnly' }], content: { mimeType: 'text/html', text: 'ok' } },
    })]));
    // Default identity redaction misses these values: a HAR header keeps its name and value in separate fields, so nothing
    // inside the value says "cookie" or "api key". The header name is the credential contract that masks it.
    const entry = parsed.entries[0], frozen = snapshotJson(entry);
    for (const secret of ['SECRET-SESSION-ABC', 'sk-SECRET-API-KEY', 'SECRET-X-AUTH', 'SECRET-TOKEN-XYZ', 'SECRET-ROTATED']) {
      expect(frozen).not.toContain(secret); expect(JSON.stringify(entry)).not.toContain(secret);
    }
    expect(entry.request.headers.cookie).toBe('[REDACTED]'); expect(entry.request.headers['x-api-key']).toBe('[REDACTED]');
    expect(entry.request.headers['x-auth-token']).toBe('[REDACTED]'); expect(entry.request.headers.authorization).toBe('[REDACTED]');
    expect(entry.response.headers['set-cookie']).toBe('[REDACTED]');
    // The names survive, so the frozen exchange still shows which credential contract it exercised.
    for (const name of ['cookie', 'x-api-key', 'x-auth-token', 'authorization', 'set-cookie']) expect(frozen).toContain(`"${name}"`);
    expect(entry.request.headers['x-trace']).toBe('visible-trace'); expect(entry.request.headersSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('bounds retained entries, headers and bodies and names what it discarded', () => {
    const entries = Array.from({ length: 26 }, (_, index) => harEntry(`https://fixture.test/p${index}`, {
      request: { method: 'POST', url: `https://fixture.test/p${index}`, headers: Array.from({ length: 20 }, (_, header) => ({ name: `x-header-${header}`, value: 'v'.repeat(2048) })), postData: { text: 'a'.repeat(40000) } },
      response: { status: 200, headers: [{ name: 'content-type', value: 'text/html' }], content: { text: 'b'.repeat(40000) } },
    }));
    const parsed = parseFrozenEntries(har(entries));
    expect(parsed.entries.length).toBe(FROZEN_ENTRY_LIMIT); expect(parsed.omitted).toBe(26 - FROZEN_ENTRY_LIMIT);
    expect(parsed.warnings.some(warning => warning.includes(`${FROZEN_ENTRY_LIMIT}-entry retained`))).toBe(true);
    expect(parsed.warnings.some(warning => warning.includes(`truncated at ${FROZEN_BODY_BYTES} bytes`))).toBe(true);
    for (const entry of parsed.entries) {
      expect(Object.keys(entry.request.headers).length).toBe(FROZEN_HEADER_LIMIT);
      for (const value of Object.values(entry.request.headers)) expect(Buffer.byteLength(value)).toBeLessThanOrEqual(FROZEN_HEADER_VALUE_BYTES);
      expect(entry.request.bodyTruncated).toBe(true); expect(entry.request.bodyBytes).toBe(40000);
      expect(Buffer.byteLength(entry.request.body!)).toBeLessThanOrEqual(FROZEN_BODY_BYTES);
      expect(snapshotByteLength(entry)).toBeLessThanOrEqual(FROZEN_ENTRY_BYTES);
    }
  });

  it('drops base64 bodies, skips malformed entries and never throws on a non-HAR document', () => {
    const encoded = parseFrozenEntries(har([harEntry('https://fixture.test/binary', { response: { status: 200, headers: [], content: { mimeType: 'application/octet-stream', encoding: 'base64', text: 'aGVsbG8=' } } })]));
    expect(encoded.entries.length).toBe(1); expect(encoded.entries[0].response.body).toBeUndefined(); expect(encoded.entries[0].response.bodyBytes).toBe(0);
    expect(encoded.warnings.some(warning => /base64-encoded/.test(warning))).toBe(true);
    expect(parseFrozenEntries('')).toEqual({ entries: [], warnings: ['Traffic snapshot is empty'], omitted: 0 });
    expect(parseFrozenEntries('not json')).toEqual({ entries: [], warnings: ['Traffic snapshot is not valid JSON'], omitted: 0 });
    expect(parseFrozenEntries('{"log":{"entries":{}}}').warnings[0]).toMatch(/no log\.entries/);
    const skipped = parseFrozenEntries(har([{}, { request: {} }, { request: { url: 'https://fixture.test/x', method: 'bad method!' } }]));
    expect(skipped.entries).toEqual([]); expect(skipped.warnings.some(warning => /3 HAR entries had no request URL/.test(warning))).toBe(true);
    expect(skipped.warnings).toContain('Traffic snapshot retained no usable entry');
  });

  it('derives a canonical evidence version from the ordered citations', () => {
    const first = ref(ARTIFACT_A, { role: 'baseline', position: 1 }), second = ref(ARTIFACT_B, { role: 'proof', position: 2, sha256: 'b'.repeat(64) });
    expect(evidenceVersionOf([first, second])).toMatch(/^[a-f0-9]{64}$/);
    expect(evidenceVersionOf([first, second])).toBe(evidenceVersionOf([{ ...first }, { ...second }]));
    expect(evidenceVersionOf([second, first])).not.toBe(evidenceVersionOf([first, second]));
    expect(evidenceVersionOf([{ ...first, role: 'proof' }])).not.toBe(evidenceVersionOf([first]));
    expect(evidenceVersionOf([{ ...first, position: 2 }])).not.toBe(evidenceVersionOf([first]));
    expect(evidenceVersionOf([{ ...first, sha256: 'c'.repeat(64) }])).not.toBe(evidenceVersionOf([first]));
  });

  it('binds every reproduction step to a same-run owner-frozen snapshot, or refuses the whole rating', () => {
    const notes = index([snapshotNote([{ snapshotRef: ARTIFACT_A, sha256: '1'.repeat(64) }, { snapshotRef: ARTIFACT_B, sha256: '2'.repeat(64) }])]);
    expect(resolveTrafficBinding(notes, 'run-1', [step('evidence-1', 'proof'), step('evidence-2', 'baseline')])).toEqual({ trafficRefs: [] });
    expect('evidenceVersion' in resolveTrafficBinding(notes, 'run-1', [])).toBe(false);
    const bound = resolveTrafficBinding(notes, 'run-1', [step('evidence-1', 'baseline', ARTIFACT_A), step('evidence-2', 'proof', ARTIFACT_B)]);
    expect(bound.trafficRefs).toEqual([{ role: 'baseline', position: 1, snapshotRef: ARTIFACT_A, sha256: '1'.repeat(64) }, { role: 'proof', position: 2, snapshotRef: ARTIFACT_B, sha256: '2'.repeat(64) }]);
    expect(bound.evidenceVersion).toBe(evidenceVersionOf(bound.trafficRefs));
    // A partially named reproduction would let a reader mistake the named exchange for the whole run.
    expect(() => resolveTrafficBinding(notes, 'run-1', [step('evidence-1', 'proof', ARTIFACT_A), step('evidence-2', 'baseline')])).toThrow(/TRAFFIC_REFS_INCOMPLETE/);
    expect(() => resolveTrafficBinding(notes, 'run-1', [step('evidence-1', 'baseline', ARTIFACT_A), step('evidence-2', 'proof', ARTIFACT_A)])).toThrow(/Duplicate traffic snapshot reference/);
    expect(() => resolveTrafficBinding(notes, 'run-1', [step('evidence-1', 'proof', ARTIFACT_C)])).toThrow(/Unknown same-run traffic snapshot artifact-00000000-0000-4000-8000-000000000003/);
  });

  it('ignores notes that are not a same-run owner import of this snapshot format', () => {
    const rows = [snapshotNote([{ snapshotRef: ARTIFACT_A, sha256: '1'.repeat(64) }], { by: 'worker-a', workerId: 'worker-a' }),
      snapshotNote([{ snapshotRef: ARTIFACT_B, sha256: '2'.repeat(64) }], { by: 'auditor' }),
      snapshotNote([{ snapshotRef: ARTIFACT_C, sha256: '3'.repeat(64) }], { data: { trafficSnapshot: { format: 'p2o-traffic/2', snapshots: [{ position: 1, snapshotRef: ARTIFACT_C, sha256: '3'.repeat(64) }] } } }),
      snapshotNote([{ snapshotRef: ARTIFACT_A, sha256: '1'.repeat(64) }], { runId: 'run-2' }),
      snapshotNote([{ snapshotRef: 'artifact-nope', sha256: 'not-a-hash' }, { snapshotRef: ARTIFACT_B, sha256: 'zz' }])];
    const ledger = index(rows);
    for (const snapshotRef of [ARTIFACT_A, ARTIFACT_B, ARTIFACT_C]) expect(() => resolveTrafficBinding(ledger, 'run-1', [step('evidence-1', 'proof', snapshotRef)])).toThrow(/Unknown same-run traffic snapshot/);
    // A legacy note without a run id is readable: the import predicate only drops a note that names a different run.
    expect(resolveTrafficBinding(index([snapshotNote([{ snapshotRef: ARTIFACT_A, sha256: '1'.repeat(64) }], { runId: undefined })]), 'run-1', [step('evidence-1', 'proof', ARTIFACT_A)]).trafficRefs).toHaveLength(1);
  });

  it('reads stored traffic fields defensively and drops malformed ones', () => {
    const refs = [ref(ARTIFACT_A, { role: 'baseline', position: 1 }), ref(ARTIFACT_B, { role: 'proof', position: 2, sha256: 'b'.repeat(64) })];
    const version = evidenceVersionOf(refs), stored = { caseId: 'case-1', caseRevision: 2, evidenceVersion: version, trafficRefs: refs };
    expect(storedTrafficBinding(stored)).toEqual({ trafficRefs: refs, evidenceVersion: version });
    expect(storedTrafficBinding(undefined)).toEqual({ trafficRefs: [] });
    expect(storedTrafficBinding({})).toEqual({ trafficRefs: [] });
    // An old rating without traffic evidence stays valid: no version, no refs.
    expect(storedTrafficBinding({ caseId: 'case-1', caseRevision: 2 })).toEqual({ trafficRefs: [] });
    for (const malformed of [{ ...stored, evidenceVersion: 'zz' }, { ...stored, trafficRefs: [] }, { ...stored, trafficRefs: [{ ...refs[0], position: 2 }] },
      { ...stored, trafficRefs: [{ ...refs[0], role: 'winner' }] }, { ...stored, trafficRefs: [{ ...refs[0], snapshotRef: 'artifact-nope' }] },
      { ...stored, trafficRefs: [{ ...refs[0], sha256: 'A'.repeat(64) }] }, { ...stored, trafficRefs: [{ ...refs[0] }, 'not-an-object'] }])
      expect(storedTrafficBinding(malformed)).toEqual({ trafficRefs: [] });
  });

  it('verifies the stored evidence version against the live snapshot artifacts and reports issues instead of throwing', () => {
    const digestA = hex('exchange-a'), refs = [ref(ARTIFACT_A, { role: 'baseline', position: 1, sha256: digestA })];
    const reader = (snapshotRef: string) => { if (snapshotRef === ARTIFACT_A) return Buffer.from('exchange-a'); throw Error('artifact gone'); };
    const ok = verifyTrafficEvidence(index([snapshotNote([{ snapshotRef: ARTIFACT_A, sha256: digestA }]), ratingNote(refs)]), reader);
    expect(ok).toEqual({ ok: true, issues: [], versions: [{ caseId: 'case-1', evidenceVersion: evidenceVersionOf(refs) }] });
    const unknown = verifyTrafficEvidence(index([ratingNote(refs)]), reader);
    expect(unknown.ok).toBe(false); expect(unknown.issues[0]).toMatch(/unknown traffic snapshot/); expect(unknown.versions).toHaveLength(1);
    const mismatched = verifyTrafficEvidence(index([snapshotNote([{ snapshotRef: ARTIFACT_A, sha256: 'd'.repeat(64) }]), ratingNote([{ ...refs[0], sha256: 'd'.repeat(64) }])]), reader);
    expect(mismatched.ok).toBe(false); expect(mismatched.issues[0]).toMatch(/does not match its stored hash/);
    const unreadable = verifyTrafficEvidence(index([snapshotNote([{ snapshotRef: ARTIFACT_A, sha256: digestA }]), ratingNote(refs)]), () => { throw Error('gone'); });
    expect(unreadable.ok).toBe(false); expect(unreadable.issues[0]).toMatch(/is no longer readable/);
    const drifted = verifyTrafficEvidence(index([snapshotNote([{ snapshotRef: ARTIFACT_A, sha256: digestA }]), ratingNote(refs, {}, 'f'.repeat(64))]), reader);
    expect(drifted.ok).toBe(false); expect(drifted.issues[0]).toMatch(/evidence version .* does not match the cited snapshots/);
    const malformed = verifyTrafficEvidence(index([snapshotNote([{ snapshotRef: ARTIFACT_A, sha256: digestA }]), ratingNote([{ ...refs[0], position: 2 }])]), reader);
    expect(malformed.ok).toBe(false); expect(malformed.issues[0]).toMatch(/malformed traffic binding/);
    // A worker-recorded note is never traffic authority, so it is not verified or counted.
    expect(verifyTrafficEvidence(index([ratingNote(refs, { by: 'worker-a', workerId: 'worker-a' })]), reader)).toEqual({ ok: true, issues: [], versions: [] });
    // The report needs a bounded refusal line, not one line per issue.
    const flooded = verifyTrafficEvidence(index(Array.from({ length: 12 }, (_, at) => ratingNote([ref(`artifact-00000000-0000-4000-8000-0000000000${String(at).padStart(2, '0')}`)]))), reader);
    expect(flooded.ok).toBe(false); expect(flooded.issues).toHaveLength(10); expect(flooded.issues[flooded.issues.length - 1]).toBe('and 3 more evidence issue(s)');
  });
});

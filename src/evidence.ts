import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { appendRecord, readRecords, type AssessmentRecord } from './records.js';
import type { ProcessResult } from './process.js';
import { CAPABILITY_IDS } from './capabilities.js';

export interface Candidate {
  candidate: string; surface: string; risk: string;
  closure: 'confirmed' | 'ruled_out' | 'open_proof_gap';
  execution: 'tested' | 'not_tested' | 'blocked' | 'not_applicable';
  proof: 'static_trace' | 'offline_reproduction' | 'live_reproduction';
  evidenceRefs: string[]; negativeControls: string[]; limitations: string;
  control?: string; requirement?: string; supersedes?: string; independentEvidenceRef?: string; resolves?: string[];
}
/** Best-effort defensive redaction; exports contain only the bounded receipts, never tickets or process env. */
export function redact(value: string): string {
  return value.replace(/(authorization|proxy-authorization|cookie|set-cookie)\s*:[^\r\n]*/gi, '$1: [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)["']?[^\s"'&,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}
const bounded = (s: string, n: number) => {
  let result = redact(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, n);
  while (Buffer.byteLength(JSON.stringify(result)) > n) result = result.slice(0, Math.floor(result.length * 0.75));
  return result;
};

export class EvidenceStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly runId: string, readonly path: string, readonly target: string) {}
  async receipt(by: string, operation: string, input: string, result: ProcessResult, startedAt: string): Promise<string> {
    const id = randomUUID();
    await appendRecord(this.path, { id, runId: this.runId, at: new Date().toISOString(), by, workerId: by === 'owner' ? undefined : by,
      kind: 'evidence', text: `${operation} exit ${result.code}; untrusted observation, not a finding`,
      data: { operation, input: bounded(input, 2000), target: this.target, startedAt, exitCode: result.code,
        stdout: bounded(result.stdout, 4000), stderr: bounded(result.stderr, 1000),
        outputSha256: createHash('sha256').update(result.stdout).update(result.stderr).digest('hex'),
        truncated: result.truncated || result.stdout.length > 4000 || result.stderr.length > 1000,
        limitations: 'Bounded redacted tool output; command semantics and claimed effect require review.' } });
    return id;
  }
  candidate(by: string, input: Candidate): Promise<AssessmentRecord> {
    const task = this.pending.then(async () => {
      validateCandidate(input);
      const records = await readRecords(this.path, 10000);
      const evidence = records.filter(r => r.kind === 'evidence' && r.runId === this.runId);
      const references = [...input.evidenceRefs, ...input.negativeControls];
      for (const id of references) if (!evidence.some(r => r.id === id)) throw new Error(`Unknown same-run evidence ID: ${id}`);
      for (const id of input.resolves ?? []) {
        if (!records.some(r => r.id === id && r.kind === 'open')) throw new Error(`Unknown open-item ID: ${id}`);
        if (input.closure === 'open_proof_gap') throw new Error('Resolving an open item needs a closed candidate with evidence');
      }
      const previous = records.filter(r => r.kind === 'candidate' && r.data?.candidate === input.candidate).at(-1);
      if (previous && input.supersedes !== previous.id) throw new Error(`Candidate revision must supersede latest ID ${previous.id}`);
      if (input.supersedes && (!previous || input.supersedes !== previous.id)) throw new Error('Invalid candidate revision');
      if (input.independentEvidenceRef) {
        const independent = evidence.find(r => r.id === input.independentEvidenceRef);
        if (!independent?.workerId || independent.by === by || !references.includes(input.independentEvidenceRef)) throw new Error('Independent validation needs a cited receipt from a different worker');
        const reproduced = records.some(r => r.kind === 'candidate' && r.by === independent.by && r.data?.candidate === input.candidate
          && r.data?.surface === input.surface && r.data?.risk === input.risk && r.data?.execution === 'tested'
          && r.data?.proof !== 'static_trace' && r.data?.closure === 'confirmed' && r.refs?.includes(independent.id!));
        if (!reproduced) throw new Error('Independent claim needs the other worker\'s matching runtime candidate and cited receipt');
      }
      const record: AssessmentRecord = { id: randomUUID(), version: 2, runId: this.runId, at: new Date().toISOString(), by,
        workerId: by === 'owner' ? undefined : by, kind: 'candidate', text: `${input.candidate}: ${input.closure} (${input.execution}, ${input.proof}); agent claim, not automatic verification`,
        surface: input.surface, risk: input.risk, outcome: input.closure, refs: input.evidenceRefs,
        supersedes: input.supersedes, resolves: input.resolves, data: { ...input } };
      await appendRecord(this.path, record);
      return record;
    });
    this.pending = task.catch(() => {});
    return task;
  }
  async exportTo(cwd: string, manifest: Record<string, unknown>): Promise<string> {
    await this.pending;
    const directory = join(cwd, '.p2o-reports');
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    return this.writeExport(directory, manifest);
  }
  private async writeExport(directory: string, manifest: Record<string, unknown>): Promise<string> {
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (((await dir.stat()).mode & 0o777) !== 0o700) throw new Error('Export directory must have mode 0700');
      const records = await readRecords(this.path, 10000, true);
      if (!records.length) throw new Error('Cannot export an empty assessment ledger');
      const payload = { version: 2, runId: this.runId, manifest, records,
        warning: 'Redaction is best effort; review before sharing. Candidate records are attributed claims, not verified findings.' };
      // Walk string values rather than a serialized JSON string, so redaction cannot corrupt JSON framing.
      const clean = (v: unknown): unknown => typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(clean)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k, clean(x)])) : v;
      const body = JSON.stringify(clean(payload), null, 2);
      if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error('Export exceeds 16 MiB; cleanup will still proceed');
      const name = `${this.runId}-${randomUUID()}.json`;
      const file = await open(`/proc/self/fd/${dir.fd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      return join(directory, name);
    } finally { await dir.close(); }
  }
}
function validateCandidate(c: Candidate): void {
  if (!c || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(c.candidate) || !c.surface || !c.risk || !c.limitations) throw new Error('Candidate needs id, surface, risk and limitations');
  if (!['confirmed', 'ruled_out', 'open_proof_gap'].includes(c.closure) || !['tested', 'not_tested', 'blocked', 'not_applicable'].includes(c.execution)
    || !['static_trace', 'offline_reproduction', 'live_reproduction'].includes(c.proof)) throw new Error('Invalid candidate state');
  if (!Array.isArray(c.evidenceRefs) || !Array.isArray(c.negativeControls) || c.evidenceRefs.length > 10 || c.negativeControls.length > 10) throw new Error('Evidence arrays must be bounded');
  if (c.closure !== 'open_proof_gap' && !c.evidenceRefs.length) throw new Error('Closure needs evidence; otherwise use open_proof_gap');
  if (c.closure === 'ruled_out' && !c.control?.trim()) throw new Error('ruled_out needs the specific control and its location');
  if (c.resolves && (!Array.isArray(c.resolves) || c.resolves.length > 10 || c.resolves.some(id => typeof id !== 'string'))) throw new Error('Invalid resolved open-item list');
  if (c.execution === 'blocked' && !(CAPABILITY_IDS as readonly string[]).includes(c.requirement ?? '')) throw new Error('blocked needs a known capability requirement');
  if (c.execution === 'blocked' && c.closure !== 'open_proof_gap') throw new Error('Blocked execution cannot establish closure');
  if (c.proof !== 'static_trace' && c.execution !== 'tested') throw new Error('Runtime proof requires tested execution');
}

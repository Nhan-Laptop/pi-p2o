/**
 * planning_update.md P16.3 + P16.8: writing back is part of finishing, and the host counts it. No review is refused for a
 * worker that wrote nothing — the counts are printed in the worker list, the report and the preflight advisory, so the lead
 * and the human can see which worker explored without leaving anything behind.
 */
import type { AssessmentRecord } from './records.js';

export interface WorkerWrites { workerId: string; assets: number; facts: number; evidence: number; findings: number; noNew: boolean }

/** The one honest way to write zero graph rows: a note that says the surface added nothing. */
export const NO_NEW_NOTE = /^no-new\b/i;

export interface WriteBackInput {
  provenance: ReadonlyArray<{ actorId?: string; entityId?: string }>;
  records: readonly AssessmentRecord[];
  /** Findings per worker come from the live report (in memory); offline renders simply omit them. */
  findings?: ReadonlyMap<string, number>;
}

/** Counts what each worker persisted: asset/assertion observations, receipts and reported findings. */
export function writeBack(input: WriteBackInput): WorkerWrites[] {
  const rows = new Map<string, WorkerWrites>();
  const entry = (workerId: string): WorkerWrites => {
    const existing = rows.get(workerId);
    if (existing) return existing;
    const created: WorkerWrites = { workerId, assets: 0, facts: 0, evidence: 0, findings: 0, noNew: false };
    rows.set(workerId, created);
    return created;
  };
  for (const observation of input.provenance) {
    if (!observation.actorId) continue;
    const entity = observation.entityId ?? '';
    if (entity.startsWith('asset-')) entry(observation.actorId).assets += 1;
    else if (entity.startsWith('assertion-')) entry(observation.actorId).facts += 1;
  }
  for (const record of input.records) {
    const workerId = record.workerId ?? record.by;
    if (!workerId || workerId === 'owner') continue;
    if (record.kind === 'evidence') entry(workerId).evidence += 1;
    else if (record.kind === 'note' && NO_NEW_NOTE.test(record.text)) entry(workerId).noNew = true;
  }
  for (const [workerId, count] of input.findings ?? []) entry(workerId).findings = count;
  return [...rows.values()];
}

/** `wrote 2 asset(s), 3 fact(s), 4 evidence, 1 finding(s)` or the advisory sentence that names the gap. */
export function writeBackLine(writes: WorkerWrites): string {
  const counts = `${writes.assets} asset(s), ${writes.facts} fact(s), ${writes.evidence} evidence, ${writes.findings} finding(s)`;
  if (writes.assets + writes.facts + writes.evidence + writes.findings === 0) return writes.noNew ? `wrote ${counts}; recorded no-new` : `NO_GRAPH_WRITE: ${counts}`;
  return `wrote ${counts}${writes.noNew ? '; recorded no-new' : ''}`;
}

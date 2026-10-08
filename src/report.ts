import { createHash, randomUUID } from 'node:crypto';
import { appendRecord, readLedger, summarizeRecords, type AssessmentRecord, type LedgerIndex } from './records.js';
import { normalizeReport, type WorkerReport } from './broker.js';
import { redact } from './evidence.js';
import { taskFrontier } from './tasks.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Bounded normalized report, split without increasing the 16 KiB append ceiling. Manifest is the commit. */
export async function persistReport(path: string, runId: string, workerId: string, report: WorkerReport, role?: string, depth?: number): Promise<string> {
  const redacted = JSON.parse(JSON.stringify(report,(_key,value) => typeof value === 'string' ? redact(value) : value));
  const body = JSON.stringify(normalizeReport(redacted));
  if (Buffer.byteLength(body) > 128 * 1024) throw new Error('Normalized report exceeds storage bound');
  const reportId = randomUUID(), parts: string[] = [], ids: string[] = [];
  let text = '', count = 0;
  for (const char of body) { text += char; if (++count === 2000) { parts.push(text); text = ''; count = 0; } }
  if (text) parts.push(text);
  for (const [part, value] of parts.entries()) {
    const id = randomUUID(); ids.push(id);
    await appendRecord(path, { id, runId, at: new Date().toISOString(), by: workerId, workerId, role, depth, kind: 'report_part',
      text: 'Attributed report part; not proof', data: { reportId, part, value, sha256: hash(value), redacted:true } });
  }
  await appendRecord(path, { id: reportId, runId, at: new Date().toISOString(), by: workerId, workerId, role, depth, kind: 'report',
    text: report.summary.slice(0, 2000), refs: report.evidence.slice(0, 10),
    data: { reportId, parts: ids, bytes: Buffer.byteLength(body), sha256: hash(body), confidence: report.confidence, blocked: report.blocked, attributed: true } });
  return reportId;
}

export function recoverReports(index: LedgerIndex): { reports: Array<{ id: string; workerId?: string; report: WorkerReport }>; diagnostics: string[] } {
  const reports: Array<{ id: string; workerId?: string; report: WorkerReport }> = [], diagnostics: string[] = [];
  const committed = new Set<string>();
  for (const row of index.records.filter(r => r.kind === 'report' && r.data?.parts)) {
    try {
      if (!row.id || !Array.isArray(row.data!.parts) || row.data!.parts.length > 128) throw Error();
      committed.add(row.id);
      const values = row.data!.parts.map((id, part) => {
        const r = index.byId.get(String(id));
        if (r?.kind !== 'report_part' || r.by !== row.by || r.data?.reportId !== row.id || r.data?.part !== part || typeof r.data?.value !== 'string' || hash(r.data.value) !== r.data.sha256) throw Error();
        return r.data.value;
      });
      const body = values.join('');
      if (hash(body) !== row.data!.sha256 || Buffer.byteLength(body) !== row.data!.bytes) throw Error();
      const report = JSON.parse(body);
      if (JSON.stringify(normalizeReport(report)) !== JSON.stringify(report)) throw Error();
      reports.push({ id: row.id, workerId: row.workerId, report });
    } catch { diagnostics.push(`Incomplete or corrupt report ${row.id ?? 'legacy'}`); }
  }
  if (index.records.some(r => r.kind === 'report_part' && !committed.has(String(r.data?.reportId)))) diagnostics.push('Uncommitted report parts present');
  if (index.records.some(r => r.kind === 'report' && !r.data?.parts)) diagnostics.push('Legacy reports have no complete normalized payload');
  return { reports, diagnostics: diagnostics.slice(0, 40) };
}

/** Frozen bounded navigation manifest. Full detail stays in active ID queries / opt-in bounded export. */
export function reportProjection(index: LedgerIndex) {
  const summary = summarizeRecords(index.records), recovered = recoverReports(index);
  const replaced = new Set(index.records.flatMap(r => r.supersedes ? [r.supersedes] : []));
  const resolved = new Set(index.records.flatMap(r => r.resolves ?? []));
  const candidates = index.records.filter(r => r.kind === 'candidate' && !replaced.has(r.id!));
  const currentByActor = new Map<string,AssessmentRecord>();
  const actorKey = (r:AssessmentRecord) => JSON.stringify([r.by,r.data?.candidate]);
  for (const row of index.records) if (row.kind === 'candidate') currentByActor.set(actorKey(row),row);
  const staleIndependent: string[] = [];
  for (const row of candidates) {
    const ref = row.data?.independentEvidenceRef;
    if (typeof ref !== 'string') continue;
    const evidence = index.byId.get(ref), latest = currentByActor.get(JSON.stringify([evidence?.by,row.data?.candidate]));
    if (!evidence?.workerId || evidence.by === row.by || !latest || latest.data?.closure !== 'confirmed' || latest.data?.execution !== 'tested' || latest.data?.proof === 'static_trace' || latest.surface !== row.surface || latest.risk !== row.risk || !latest.refs?.includes(ref)) staleIndependent.push(row.id!);
  }
  const stale = new Set(staleIndependent);
  const short = (value:unknown) => typeof value === 'string' ? value.slice(0,250) : undefined;
  const frontier = candidates.map(r => ({id:r.id,candidate:r.data?.candidate,surface:r.surface,risk:r.risk,closure:r.data?.closure,execution:r.data?.execution,proof:r.data?.proof,
    policyBasis:r.data?.policyBasis,controls:r.data?.negativeControls,evidenceRefs:r.refs,control:short(r.data?.control),limitations:short(r.data?.limitations),blocked:short(r.data?.requirement),
    independentCurrent:typeof r.data?.independentEvidenceRef === 'string' ? !stale.has(r.id!) : undefined}));
  const latestReports = new Map<string,typeof recovered.reports[number]>();
  for (const report of recovered.reports) latestReports.set(report.workerId ?? report.id,report);
  const reports = [...latestReports.values()].map(r => ({id:r.id,workerId:r.workerId,confidence:r.report.confidence,blocked:short(r.report.blocked),outcome:r.report.outcome,
    evidenceRefs:r.report.evidence.slice(0,10),findings:r.report.findings.length,openItems:r.report.openItems.length,attributed:true}));
  const digest = createHash('sha256'); for (const record of index.records) digest.update(JSON.stringify(record)).update('\n');
  const tasks = taskFrontier(index).map(t => ({id:t.id,recordId:t.recordId,status:t.status}));
  const openIds = index.records.filter(r => !resolved.has(r.id!) && (r.kind === 'open' || (r.kind === 'candidate' && !replaced.has(r.id!) && (r.data?.closure === 'open_proof_gap' || r.data?.execution === 'blocked')))).map(r => r.id ?? '(legacy-no-id)');
  const take = <T>(rows:T[],bytes:number) => {const result:T[]=[];let used=0;for(const row of rows){used+=Buffer.byteLength(JSON.stringify(row))+1;if(used>bytes || result.length===100)break;result.push(row);}return result;};
  const shownCandidates=take(frontier,16384),shownReports=take(reports,8192),shownTasks=take(tasks,8192),shownOpen=take(openIds,4096);
  return {
    version:digest.digest('hex'),complete:index.complete && recovered.diagnostics.length===0,totalRecords:index.records.length,
    counts:{candidates:candidates.length,reports:reports.length,reportHistory:recovered.reports.length,coverage:summary.coverageTotal,open:summary.openTotal,unreviewedTasks:tasks.filter(t => !['reviewed','closed'].includes(t.status)).length},
    tasks:shownTasks,candidates:shownCandidates,reports:shownReports,reportIds:shownReports.map(r => r.id),openIds:shownOpen,
    omitted:frontier.length-shownCandidates.length+reports.length-shownReports.length+tasks.length-shownTasks.length+openIds.length-shownOpen.length,
    staleIndependent:staleIndependent.slice(0,100),diagnostics:[...index.diagnostics,...recovered.diagnostics].slice(0,40),
    warning:'Frozen attributed state, not semantic proof. Fields/views can be abbreviated; full detail requires pre-cleanup ID queries or opt-in export. No export means temporary records are deleted.',
  };
}

export async function freezeReport(path: string, runId: string) { return reportProjection(await readLedger(path, runId)); }

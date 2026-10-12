import { awaitingReview, taskFrontier, type AssessmentTask } from '../tasks.js';
import { reportProjection, type ReportProjectionContext } from '../report.js';
import { caseViews } from '../cases.js';
import { coverageViews } from '../coverage.js';
import { safeText } from '../evidence.js';
import type { LedgerIndex } from '../records.js';
import type { AssessmentEngine } from '../engine.js';
import { phasePackets, planFrontier } from '../planning.js';
import { STATE_SCHEMA_VERSION } from '../state/schema.js';
import { validId } from '../validate.js';
import { dashboardLines } from './dashboard.js';

export type StateCommand = { action: 'status' } | { action: 'report' } | { action: 'tasks'; filter: string; cursor: number }
  | { action: 'task'; id: string } | { action:'plan';id:string } | { action:'phase';id:string } | {action:'finding';id:string}|{action:'coverage-cell';id:string}
  | { action:'plans';cursor:number } | { action:'phases';cursor:number } | {action:'findings';cursor:number}|{action:'coverage';cursor:number}| { action: 'log'; cursor?: number; taskId?: string; actorId?: string; operationId?: string };
const filters = ['all', 'live', 'awaiting-review', 'blocked', 'done'];
const integer = (text: string) => {
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw Error('Cursor must be a non-negative safe integer');
  return Number(text);
};
/** Human-only, read-only commands. Not a model input or an execution capability. */
export function parseStateCommand(args: string): StateCommand | undefined {
  const [action, ...parts] = args.trim().split(/\s+/);
  if (!['status', 'tasks', 'task', 'log', 'report','plans','plan','phases','phase','findings','finding','coverage','coverage-cell'].includes(action)) return undefined;
  if (action === 'status' || action === 'report') {
    if (parts.length) throw Error(`${action} takes no arguments`);
    return { action };
  }
  if (action === 'task'||action==='plan'||action==='phase'||action==='finding'||action==='coverage-cell') {
    if (parts.length !== 1 || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(parts[0])) throw Error(`Usage: /p2o ${action} <id>`);
    return { action, id: parts[0] };
  }
  if(action==='plans'||action==='phases'||action==='findings'||action==='coverage'){if(parts.length>1)throw Error(`Usage: /p2o ${action} [cursor]`);return {action,cursor:parts[0]?integer(parts[0]):0};}
  if (action === 'log') {
    const usage = 'Usage: /p2o log [cursor] [task=<id>] [actor=<id>] [operation=<id>]', keys = { task: 'taskId', actor: 'actorId', operation: 'operationId' } as const;
    const command: Extract<StateCommand, { action: 'log' }> = { action };
    for (const part of parts) {
      if (/^\d+$/.test(part)) { if (command.cursor !== undefined) throw Error(usage); command.cursor = integer(part); continue; }
      const match = /^(task|actor|operation)=(.+)$/.exec(part);
      if (!match || !validId(match[2]) || command[keys[match[1] as keyof typeof keys]] !== undefined) throw Error(usage);
      command[keys[match[1] as keyof typeof keys]] = match[2];
    }
    return command;
  }

  if (parts.length > 2 || (parts[0] && !filters.includes(parts[0]))) throw Error('Usage: /p2o tasks [all|live|awaiting-review|blocked|done] [cursor]');
  return { action: 'tasks', filter: parts[0] ?? 'all', cursor: parts[1] ? integer(parts[1]) : 0 };
}

const safe = (text: string, limit = 200) => safeText(text).replace(/\s+/g, ' ').slice(0, limit);
const reviewLabel = (task: AssessmentTask) => awaitingReview(task) ? `${task.status} — awaiting owner review` : task.status;
export interface ViewProfile {
  runId: string; target: string; lifecycle: string; delegation: boolean; maxWorkers: number;
  workerUsed: number; workerCeiling: number; exportEnabled: boolean; exportPath?: string; exportError?: string;
  engine: ReturnType<AssessmentEngine['snapshot']>; executor: { mode: string; maxTargetOperations: number; runningTargetOperations?: number; waitingTargetOperations?: number };
  retention?: 'durable-local' | 'ephemeral'; stateLocation?: string; storageError?: string;
  runtime?: { version: string; sha256: string; policy?: number | 'off' };
  workers?: WorkerView[]; held?: { reason: string; at: number }; usageLines?: string[];
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null; at: number };
}
/** Local observation only. `quiet` means no local event for the quiet window while queued/running; it is not failure proof, a timeout or a model wake. */
export interface WorkerView { id: string; role: string; taskId?: string; state: string; commandsUsed: number; commandBudget: number; idleMs?: number; quiet: boolean; reported: boolean; stopped: boolean }
const age = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h`;
const MAX_WORKER_LINES = 12;
export function workerLines(workers: WorkerView[], maxWorkers: number): string[] {
  if (!workers.length) return [];
  const live = workers.filter(w => !w.reported && !w.stopped), quiet = live.filter(w => w.quiet).length;
  const lines = [`Workers: live ${live.length}/${maxWorkers} slots (quiet ${quiet}) | reported ${workers.filter(w => w.reported).length} | stopped ${workers.filter(w => w.stopped && !w.reported).length}`];
  for (const w of live.slice(0, MAX_WORKER_LINES)) lines.push(`  ${safe(w.id, 80)} · ${safe(w.role, 20)} · task ${w.taskId ? safe(w.taskId, 80) : 'none'} · ${safe(w.state, 24)} · ${w.commandsUsed}/${w.commandBudget} cmds${w.idleMs !== undefined ? ` · idle ${age(w.idleMs)}` : ''}${w.quiet ? ' · QUIET' : ''}`);
  if (live.length > MAX_WORKER_LINES) lines.push(`  … ${live.length - MAX_WORKER_LINES} more live workers; /p2o log actor=<worker-id> filters one worker's events`);
  if (quiet) lines.push('QUIET = no local event for 120 s while queued/running. It is not proof of failure, not a timeout and wakes no model; /p2o log actor=<worker-id> shows what it last did.');
  return lines;
}
export interface StatusView {
  schemaVersion: 1; runId: string; lifecycle: string; asOfRecordCount: number; complete: boolean; diagnostics: string[];
  taskCounts: Record<string, number>; reportCount: number; candidateClaims: number; openEntries: number;
  pendingReview: number; acceptedFindings:number; pendingCaseReviews:number; staleCases:number; coverageCells:number; retained: boolean; lines: string[]; widget: string[];
}

/** Legacy v2 projection. Counts are records/tasks, never test cells or validated findings. */
export function statusView(index: LedgerIndex, profile: ViewProfile, context:ReportProjectionContext={}): StatusView {
  const tasks = taskFrontier(index), report = reportProjection(index,context), cases = caseViews(index, context.cases ?? {});
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  const pendingReview = tasks.filter(awaitingReview).length;
  const last = index.records.filter(r => !['report_part', 'evidence'].includes(r.kind) && !(r.kind === 'lifecycle' && /^skill_(list|read)/.test(r.text))).at(-1);
  const retained = profile.retention === 'durable-local' || Boolean(profile.exportPath);
  const retention = profile.storageError ? `RETENTION WARNING: ${safe(profile.storageError,500)}; retained bytes/integrity unknown at ${profile.stateLocation ?? '(unknown)'}`
    : profile.retention === 'durable-local' ? `Durable-local knowledge: ${profile.stateLocation}; retained after cleanup, read-only reopening only.${profile.exportError ? ` Export warning: ${safe(profile.exportError,500)}` : ''}`
    : profile.exportError ? `RETENTION WARNING: ${safe(profile.exportError, 500)}`
    : retained ? `Export: ${profile.exportPath}`
    : profile.exportEnabled ? 'Ephemeral full ledger; export requested at cleanup (not yet saved).'
    : 'Ephemeral full ledger — deleted at cleanup. No durable checkpoint yet; use --export on a new run to retain bounded receipts.';
  const title = `P2O ${profile.runId} · ${profile.lifecycle} · ${profile.engine.mode}/${profile.executor.mode} · records @${index.records.length}`;
  const taskLine = `Tasks ${tasks.length}: proposed ${counts.proposed ?? 0} | reserved ${counts.reserved ?? 0} | running ${counts.running ?? 0} | awaiting-review ${pendingReview} | reviewed ${counts.reviewed ?? 0} | closed ${counts.closed ?? 0} | blocked ${counts.blocked ?? 0} | cancelled/expired ${(counts.cancelled ?? 0) + (counts.expired ?? 0)}`;
  const attention = profile.engine.paused ? `Admission paused: ${safe(profile.engine.paused, 500)}`
    : pendingReview ? `Next: review ${pendingReview} reported task(s); report alone does not close a goal.`
    : profile.engine.decision ? `Planner ${profile.engine.decision.disposition}: ${safe(profile.engine.decision.reason, 500)}`
    : 'No disposition recorded. Empty findings/queue do not mean the target is safe.';
  const diagnostics = [...index.diagnostics, ...report.diagnostics].slice(0, 40);
  return {
    schemaVersion: 1, runId: profile.runId, lifecycle: profile.lifecycle, asOfRecordCount: index.records.length,
    complete: report.complete, diagnostics, taskCounts: counts, reportCount: report.counts.reports,
    candidateClaims: report.counts.candidates, openEntries: report.counts.open, pendingReview,acceptedFindings:report.counts.uniqueAcceptedFindings,pendingCaseReviews:report.counts.pendingCaseReviews,staleCases:report.counts.staleCases,coverageCells:report.counts.coverageCells, retained,
    lines: [title,
      ...(pendingReview ? [`⚠ ${pendingReview} worker report${pendingReview === 1 ? '' : 's'} awaiting Planner review — report alone does not close a goal.`] : []),
      `Target: ${safe(profile.target, 1000)}`,
      ...(profile.held ? [`HOLD: new target commands and worker launches are refused until /p2o release — ${safe(profile.held.reason, 300)}. Commands already running finish; reporting and /p2o stop stay available.`] : []),
      ...(profile.runtime ? [`Runtime: p2o ${safe(profile.runtime.version || 'unknown version', 40)} · ${safe(profile.runtime.sha256, 64).slice(0, 12)} (digest of the entry file + src closure; identifies code, not safety)${profile.runtime.policy !== undefined ? `; tool guidance ${profile.runtime.policy === 'off' ? 'off' : `v${profile.runtime.policy}`}` : ''}`] : []), taskLine,
      `Worker slots: ${profile.delegation ? profile.maxWorkers : 0}; target-operation cap: ${profile.executor.maxTargetOperations} (not network rate/connections)`,
      `Frontier: ${profile.engine.pendingIntents} accepted pending intents; automatic wakes ${profile.engine.rounds}/${profile.engine.maxAutomaticRounds}`,
      `Worker commands: ${profile.workerUsed}/${profile.workerCeiling} run allowance (worker reserve 90%; owner commands/provider cost separate)`,
      ...workerLines(profile.workers ?? [], profile.maxWorkers),
      ...(profile.usageLines ?? []).map(line => safe(line, 400)),
      `Planner context: ${profile.contextUsage ? (profile.contextUsage.percent != null && profile.contextUsage.tokens != null ? `${Math.round(profile.contextUsage.percent)}% (${profile.contextUsage.tokens} of ${profile.contextUsage.contextWindow} tokens) at the last request` : `unknown right now (window ${profile.contextUsage.contextWindow} tokens)`) : 'not reported yet'}; measurement only, p2o never compacts or summarizes the Planner session itself.`,
      `Handoffs ${report.counts.reports} | claims ${report.counts.candidates} | cases accepted-current ${report.counts.uniqueAcceptedFindings}, pending ${report.counts.pendingCaseReviews}, stale ${report.counts.staleCases} | coverage cells ${report.counts.coverageCells} | open ${report.counts.open}`,
      attention, `Last committed record: ${last ? `${last.id ?? 'legacy-no-id'} ${safe(last.text, 350)}` : '(none)'}`, retention,
      `Reconciliation: ${report.complete ? 'complete bounded record scan' : 'INCOMPLETE — no completeness claim'}${diagnostics.length ? `; ${diagnostics.map(x => safe(x, 150)).join('; ')}` : ''}`,
      'Reported ≠ reviewed; closed task ≠ verified finding; resources cleaned ≠ assessment complete.',
      index.snapshotSequence !== undefined ? `Canonical store v${STATE_SCHEMA_VERSION} / records v2; committed sequence @${index.snapshotSequence}. Missing operation correlation stays unknown.` : 'Legacy v2 view: record cursor is not a durable event sequence; operation history/correlation may be unknown.'],
    widget: [title, ...(profile.held ? [`HOLD: ${safe(profile.held.reason, 120)}`] : []),
      ...(profile.workers?.length ? [(() => {
        const live = profile.workers!.filter(w => !w.reported && !w.stopped);
        const rows = live.length && live.length <= 3 ? ` · ${live.map(w => `${safe(w.id, 40)}(${safe(w.state, 16)}${w.taskId ? ` ${safe(w.taskId, 40)}` : ''})`).join(', ')}` : '';
        return `Workers: live ${live.length} (quiet ${live.filter(w => w.quiet).length}) | reported ${profile.workers!.filter(w => w.reported).length}${rows}`;
      })()] : []),
      ...dashboardLines(profile, report, cases),
      `${attention} ${report.complete ? '' : 'STATE INCOMPLETE.'}`],
  };
}

export function stateLines(index: LedgerIndex, command: Exclude<StateCommand, { action: 'status' }>, context:ReportProjectionContext={}): string[] {
  const tasks = taskFrontier(index);
  const health = `${index.snapshotSequence !== undefined ? `Canonical store snapshot @${index.snapshotSequence} / records v2` : `Legacy v2 record snapshot @${index.records.length}`}; complete=${index.complete}. Target-derived text is untrusted data.`;
  if(command.action==='plans'||command.action==='plan'){
    const all=planFrontier(index);if(command.action==='plan'){const entry=all.find(row=>row.id===command.id);if(!entry)throw Error('Unknown plan ID in this run');
      return [health,`${entry.id}@r${entry.revision} ${entry.kind}: ${entry.status}`,`Title: ${safe(entry.title,500)}`,`Reason: ${safe(entry.reason,1000)}`,
        `Criteria: ${(entry.criteria??[]).map(value=>safe(value,500)).join(' | ')||'(none)'}`,`Excluded: ${(entry.exclusions??[]).map(value=>safe(value,500)).join(' | ')||'(none)'}`,
        `Task refs: ${entry.taskIds?.join(', ')||'(none)'}`,`Goal refs: ${entry.goalIds?.join(', ')||'(none)'}`,`Support refs: ${entry.supportRefs?.join(', ')||'(none)'}`,
        ...(entry.decision?[`Decision: ${safe(JSON.stringify(entry.decision),3000)}`]:[]),'Owner coordination only; not proof, scope, automatic dispatch or goal completion.'];}
    if(command.cursor>all.length)throw Error('Plan cursor is beyond the snapshot');const page=all.slice(command.cursor,command.cursor+20),next=command.cursor+page.length;
    return [health,`Plans: total ${all.length}, displayed ${page.length}, cursor ${command.cursor}`,...(next<all.length?[`Next: /p2o plans ${next}`]:[]),...page.map(row=>`${row.id}@r${row.revision} ${row.kind} [${row.status}]: ${safe(row.title,300)}`),'Snapshot-relative navigation; open details with /p2o plan <id>.'];
  }
  if(command.action==='phases'||command.action==='phase'){
    const all=phasePackets(index);if(command.action==='phase'){const phase=all.find(row=>row.id===command.id);if(!phase)throw Error('Unknown phase packet ID');const task=tasks.find(row=>row.id===phase.taskId);
      return [health,`${phase.id}: ${phase.delivery} at ${phase.at}`,`Assignment ${phase.taskId}@r${phase.taskRevision}; worker ${phase.workerId}; report ${phase.reportId}`,
        `Current task: ${task?.status??'unknown'}; delivery review status: pending (immutable history, not current acceptance)`,
        `Reported output counts (not verified): ${safe(JSON.stringify(phase.observed),1000)}`,`Desired contract: ${phase.contract?safe(JSON.stringify(phase.contract),3000):'legacy — unspecified'}`,
        `Required output still needs owner review: ${phase.unreviewedRequired.join(', ')||'(legacy unspecified)'}`,`Outcome: ${phase.outcome??'unknown'}; confidence: ${safe(phase.confidence)}`,
        ...(phase.blocked?[`Blocked: ${safe(phase.blocked,1000)}`]:[]),'Counts/contract presence do not establish completeness, independent evidence or a verified finding.'];}
    if(command.cursor>all.length)throw Error('Phase cursor is beyond the snapshot');const page=all.slice(command.cursor,command.cursor+20),next=command.cursor+page.length;
    return [health,`Phase packets: total ${all.length}, displayed ${page.length}, cursor ${command.cursor}`,...(next<all.length?[`Next: /p2o phases ${next}`]:[]),...page.map(row=>`${row.id} ${row.taskId}@r${row.taskRevision}: ${row.delivery} ${row.outcome??'unknown'}; review separately`),'Open one packet with /p2o phase <id>; historical delivery is not live authority.'];
  }
  if(command.action==='findings'||command.action==='finding'){
    const all=caseViews(index,context.cases??{});if(command.action==='finding'){const entry=all.find(row=>row.id===command.id);if(!entry)throw Error('Unknown case ID in this run');return [health,`${entry.id}@r${entry.revision}: ${entry.verdict}/${entry.reviewStatus}; currentness=${entry.currentness}`,
      `Title: ${safe(entry.title,500)}`,`Canonical case: ${entry.canonicalCaseId}; accepted unique finding=${entry.acceptedFinding}; independent current=${entry.independentCurrent}`,
      `Assets: ${entry.assetRefs.map(ref=>`${ref.id}@r${ref.revision??'?'}/${ref.variant??'-'}`).join(', ')}`,`Claims: ${entry.claimRefs.join(', ')}`,`Tasks: ${entry.taskRefs.map(ref=>`${ref.taskId}@r${ref.revision??'?'}`).join(', ')||'(none)'}`,
      `Duplicate of: ${entry.duplicateOf??'(canonical/unresolved)'}; related: ${entry.relatedCaseIds.join(', ')||'(none)'}`,`Contradictions: ${entry.contradictions.map(item=>`${item.evidenceRef}:${item.status}`).join(', ')||'(none)'}`,
      `Remediation: ${entry.remediation.status}; ${safe(entry.remediation.reason,1000)}`,`Limitations: ${safe(entry.limitations,1500)}`,`Stale reasons: ${entry.staleReasons.join(', ')||'(none)'}`,
      'Worker claim, owner case review, independent badge, remediation and goal completion are separate axes.'];}
    if(command.cursor>all.length)throw Error('Finding cursor is beyond the snapshot');const page=all.slice(command.cursor,command.cursor+20),next=command.cursor+page.length,unique=new Set(all.filter(row=>row.acceptedFinding).map(row=>row.canonicalCaseId));return [health,`Cases: ${all.length}; unique accepted-current findings ${unique.size}; displayed ${page.length}, cursor ${command.cursor}`,...(next<all.length?[`Next: /p2o findings ${next}`]:[]),...page.map(row=>`${row.id}@r${row.revision} ${row.verdict}/${row.reviewStatus} current=${row.currentness}${row.duplicateOf?` duplicate→${row.canonicalCaseId}`:''}: ${safe(row.title,300)}`),'Counts keep submissions/duplicates/pending/stale separate; open one with /p2o finding <id>.'];
  }
  if(command.action==='coverage'||command.action==='coverage-cell'){
    if(!context.coverage)throw Error('Coverage currentness unavailable in this projection; inspect through the canonical store');const plans=coverageViews(index,context.coverage);
    if(command.action==='coverage-cell'){const cell=plans.flatMap(plan=>plan.cells).find(row=>row.id===command.id);if(!cell)throw Error('Unknown current coverage cell');return [health,`${cell.id}@r${cell.revision}: execution=${cell.execution}; assessment=${cell.assessment}; effective=${cell.effectiveAssessment}; currentness=${cell.currentness}`,
      `Plan ${cell.planId}@r${cell.planRevision}; target ${cell.targetRevision}; asset ${cell.assetRef.id}@r${cell.assetRef.revision??'?'}/${cell.assetRef.variant??'-'}`,
      `Identity: ${cell.questionKey} | ${cell.policyKey??'-'} | ${cell.actorContext}/${cell.tenantContext} | ${cell.methodFamily}`,`Tasks: ${cell.taskRefs.map(ref=>`${ref.taskId}@r${ref.revision??'?'}`).join(', ')||'(none)'}`,`Claims: ${cell.claimRefs.join(', ')||'(none)'}; cases: ${cell.caseRefs.map(ref=>`${ref.caseId}@r${ref.revision}`).join(', ')||'(none)'}`,
      `Evidence: ${cell.evidenceRefs.join(', ')||'(none)'}; controls: ${cell.negativeControlRefs.join(', ')||'(none)'}; gaps: ${cell.gapRefs.join(', ')||'(none)'}`,`Reason: ${safe(cell.reason,1200)}`,`Limitations: ${safe(cell.limitations,1500)}`,`Stale reasons: ${cell.staleReasons.join(', ')||'(none)'}`,'A cell is bounded plan coverage, not whole-target safety or goal completion.'];}
    const cells=plans.flatMap(plan=>plan.cells.map(cell=>({plan,cell})));if(command.cursor>cells.length)throw Error('Coverage cursor is beyond the snapshot');const page=cells.slice(command.cursor,command.cursor+20),next=command.cursor+page.length;return [health,`Coverage: plans ${plans.length}; cells ${cells.length}; displayed ${page.length}, cursor ${command.cursor}`,...plans.slice(0,10).map(plan=>`${plan.id}@r${plan.revision} [${plan.status}] denominator=${plan.cellIds.length}; stale=${plan.counts.stale}; reviewed=${plan.counts.reviewed}; discovered-unplanned=${plan.discoveredUnplannedAssets}; unknown-scope=${plan.unknownScope.length}`),...(next<cells.length?[`Next: /p2o coverage ${next}`]:[]),...page.map(({plan,cell})=>`${cell.id}@r${cell.revision} plan=${plan.id}: ${cell.execution}/${cell.effectiveAssessment} current=${cell.currentness} ${cell.assetRef.id} ${cell.questionKey}`),'Blocked/untested/unplanned/stale cells and discovered assets never count clean; open one with /p2o coverage-cell <id>.'];
  }
  if (command.action === 'report') {
    const p = reportProjection(index,context);
    return [health, 'Attributed report index — not a final narrative or evidence review.',
      `Handoffs ${p.counts.reports}, candidate claims ${p.counts.candidates}, open entries ${p.counts.open}; complete=${p.complete}; omitted=${p.omitted}`,
      ...p.reports.map(r => `${r.id} worker=${r.workerId} outcome=${r.outcome ?? 'unknown'} findings claimed=${r.findings}; review separately`),
      ...p.candidates.map(c => `${c.id} ${safe(String(c.candidate))}: claimed ${c.closure}, ${c.execution}/${c.proof}, independentCurrent=${c.independentCurrent ?? 'not claimed'}`),
      ...p.cases.map(c=>`${c.id}@r${c.revision} ${safe(c.title)}: ${c.verdict}/${c.reviewStatus}, current=${c.currentness}, acceptedUnique=${c.acceptedFinding}, canonical=${c.canonicalCaseId}`),
      ...p.coveragePlans.map(plan=>`${plan.id}@r${plan.revision} coverage denominator=${plan.cellCount}, stale=${plan.counts.stale}, discovered-unplanned=${plan.discoveredUnplannedAssets}`),
      ...p.diagnostics, 'Full handoff: ask for its report ID via p2o_ledger; no model was called by this command.'];
  }
  if (command.action === 'task') {
    const task = tasks.find(t => t.id === command.id);
    if (!task) throw Error('Unknown task ID in this run');
    const history = index.records.filter(r => r.kind === 'task' && r.data?.task && (r.data.task as AssessmentTask).id === task.id);
    return [health, `${task.id}@r${task.revision} · ${reviewLabel(task)} · ${task.role} · ${task.assignee ?? 'unassigned'}`,
      ...['question', 'surface', 'risk', 'expectedTrue', 'expectedFalse', 'stopCondition', 'expectedOutput', 'reviewReason', 'outcome'].flatMap(key => {
        const value = task[key as keyof AssessmentTask]; return typeof value === 'string' ? [`${key}: ${safe(value, 1500)}`] : [];
      }), `Receipts: ${task.evidenceIds.join(', ') || '(none)'}`,
      `Prerequisites: ${task.prerequisites.map(p => `${p.taskId}@${p.revision ?? 'unpinned'}`).join(', ') || '(none)'}`,
      `Work confidence: ${task.dedupConfidence??'legacy unknown'}; target revision ${task.targetRevision??'unknown'}; fingerprint ${task.workFingerprint??'(unknown)'}`,
      ...(task.decision?[`Work decision: ${safe(JSON.stringify(task.decision),2200)}`]:[]),...(task.overlapWarnings?.length?[`Overlap warnings: ${task.overlapWarnings.join(', ')}`]:[]),
      ...(task.phasePacketId?[`Phase packet: /p2o phase ${task.phasePacketId}`]:[]),
      `History ${history.length} revisions (displayed last ${Math.min(20, history.length)}):`,
      ...history.slice(-20).map(r => `${r.id} · ${safe(r.text, 300)}`),
      'Review is coordination acceptance, not proof. Missing correlation/artifact history is unknown, not fabricated.'];
  }
  if (command.action === 'tasks') {
    const selected = tasks.filter(t => command.filter === 'all' || (command.filter === 'live' ? !['closed', 'cancelled', 'expired'].includes(t.status)
      : command.filter === 'awaiting-review' ? awaitingReview(t) : command.filter === 'done' ? t.status === 'closed' : t.status === 'blocked'));
    if (command.cursor > selected.length) throw Error('Task cursor is beyond the filtered snapshot');
    const page = selected.slice(command.cursor, command.cursor + 20), next = command.cursor + page.length;
    return [health, `Tasks ${command.filter}: total ${selected.length}, displayed ${page.length}, cursor ${command.cursor}`,
      ...(next < selected.length ? [`Next: /p2o tasks ${command.filter} ${next}`] : []),
      ...page.map(t => `${t.id}@r${t.revision} [${reviewLabel(t)}] ${t.role} ${t.assignee ?? 'unassigned'}: ${safe(t.question, 300)}`),
      'Task list pagination is snapshot-relative; after mutations, start at cursor 0. done means task closed, not assessment verified.'];
  }
  const cursor = command.cursor ?? Math.max(0, index.records.length - 20);
  if (cursor > index.records.length) throw Error('Log cursor is beyond the committed records');
  const page = index.records.slice(cursor, cursor + 20), next = cursor + page.length;
  return [health, `Record log: total ${index.records.length}, displayed ${page.length}, cursor ${cursor}`,
    ...(next < index.records.length ? [`Next: /p2o log ${next}`] : []),
    ...page.map((r, i) => `${cursor + i} ${r.id ?? 'legacy-no-id'} · ${r.kind} · ${safe(r.by, 80)} · ${safe(r.text, 600)}`),
    'Use /p2o log 0 for traversal. This is existing ledger history, not a complete typed operation checklog.'];
}

export const DASHBOARD_SECTIONS = ['overview', 'workers', 'tasks', 'coverage', 'cases', 'log'] as const;
export type DashboardSection = typeof DASHBOARD_SECTIONS[number];

/** Human-only. `/p2o dashboard [section|1-6]`; no section defaults to overview. */
export function parseDashboardCommand(args: string): { section: DashboardSection } | undefined {
  const [action, ...parts] = args.trim().split(/\s+/);
  if (action !== 'dashboard') return undefined;
  const usage = 'Usage: /p2o dashboard [overview|workers|tasks|coverage|cases|log]';
  if (parts.length > 1) throw Error(usage);
  const raw = parts[0];
  if (!raw) return { section: 'overview' };
  const section = /^[1-6]$/.test(raw) ? DASHBOARD_SECTIONS[Number(raw) - 1]
    : (DASHBOARD_SECTIONS as readonly string[]).includes(raw) ? raw as DashboardSection : undefined;
  if (!section) throw Error(usage);
  return { section };
}

/**
 * Per-tab content for the dashboard screen and its RPC/text fallback. Reuses the same pure projections as
 * /p2o status|workers|tasks|coverage|findings|log on an already-read LedgerIndex — no extra store read.
 */
export function dashboardSectionLines(section: DashboardSection, index: LedgerIndex, context: ReportProjectionContext, overviewLines: string[],
  workers?: { list: WorkerView[]; maxWorkers: number; held?: { reason: string } }): string[] {
  switch (section) {
    case 'overview': return overviewLines;
    case 'workers': {
      if (!workers) return ['No live worker data in this view (historical or closed run).'];
      const lines = workerLines(workers.list, workers.maxWorkers);
      return [`Workers ${workers.list.length}${workers.held ? ` — HOLD: ${safe(workers.held.reason, 300)}` : ''}`,
        ...(lines.length ? lines : ['No workers have been launched. A solo run has none.']), 'Local observation only; quiet is not proof of failure.'];
    }
    case 'tasks': return stateLines(index, { action: 'tasks', filter: 'all', cursor: 0 }, context);
    case 'coverage': return stateLines(index, { action: 'coverage', cursor: 0 }, context);
    case 'cases': return stateLines(index, { action: 'findings', cursor: 0 }, context);
    case 'log': return stateLines(index, { action: 'log' }, context);
  }
}

import { awaitingReview, taskFrontier } from '../tasks.js';
import { reportProjection, type ReportProjectionContext } from '../report.js';
import { caseViews } from '../cases.js';
import { safeText } from '../evidence.js';
import type { LedgerIndex } from '../records.js';
import type { AssessmentEngine } from '../engine.js';
import { STATE_SCHEMA_VERSION } from '../state/schema.js';
import { validId } from '../validate.js';
import { dashboardLines } from './dashboard.js';

export type StateCommand = { action: 'status' } | { action: 'report' } | { action: 'log'; cursor?: number; taskId?: string; actorId?: string; operationId?: string };
const integer = (text: string) => {
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw Error('Cursor must be a non-negative safe integer');
  return Number(text);
};
/** Human-only, read-only commands. Not a model input or an execution capability. */
export function parseStateCommand(args: string): StateCommand | undefined {
  const [action, ...parts] = args.trim().split(/\s+/);
  if (!['status', 'log', 'report'].includes(action)) return undefined;
  if (action === 'status' || action === 'report') {
    if (parts.length) throw Error(`${action} takes no arguments`);
    return { action };
  }
  const usage = 'Usage: /p2o log [cursor] [task=<id>] [actor=<id>] [operation=<id>]', keys = { task: 'taskId', actor: 'actorId', operation: 'operationId' } as const;
  const command: Extract<StateCommand, { action: 'log' }> = { action: 'log' };
  for (const part of parts) {
    if (/^\d+$/.test(part)) { if (command.cursor !== undefined) throw Error(usage); command.cursor = integer(part); continue; }
    const match = /^(task|actor|operation)=(.+)$/.exec(part);
    if (!match || !validId(match[2]) || command[keys[match[1] as keyof typeof keys]] !== undefined) throw Error(usage);
    command[keys[match[1] as keyof typeof keys]] = match[2];
  }
  return command;
}

const safe = (text: string, limit = 200) => safeText(text).replace(/\s+/g, ' ').slice(0, limit);
export interface ViewProfile {
  runId: string; target: string; lifecycle: string; delegation: boolean; maxWorkers: number;
  exportEnabled: boolean; exportPath?: string; exportError?: string;
  engine: ReturnType<AssessmentEngine['snapshot']>; executor: { mode: string; maxTargetOperations: number; runningTargetOperations?: number; waitingTargetOperations?: number };
  retention?: 'durable-local' | 'ephemeral'; stateLocation?: string; storageError?: string;
  runtime?: { version: string; sha256: string; policy?: number | 'off' };
  workers?: WorkerView[]; held?: { reason: string; at: number }; usageLines?: string[];
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null; at: number };
}
/** Local observation only. `quiet` means no local event for the quiet window while queued/running; it is not failure proof, a timeout or a model wake. */
export interface WorkerView { id: string; role: string; taskId?: string; state: string; commandsUsed: number; idleMs?: number; quiet: boolean; reported: boolean; stopped: boolean }
const age = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h`;
const MAX_WORKER_LINES = 12;
export function workerLines(workers: WorkerView[], maxWorkers: number): string[] {
  if (!workers.length) return [];
  const live = workers.filter(w => !w.reported && !w.stopped), quiet = live.filter(w => w.quiet).length;
  const lines = [`Workers: live ${live.length}/${maxWorkers} slots (quiet ${quiet}) | reported ${workers.filter(w => w.reported).length} | stopped ${workers.filter(w => w.stopped && !w.reported).length}`];
  for (const w of live.slice(0, MAX_WORKER_LINES)) lines.push(`  ${safe(w.id, 80)} · ${safe(w.role, 20)} · task ${w.taskId ? safe(w.taskId, 80) : 'none'} · ${safe(w.state, 24)} · ${w.commandsUsed} cmds${w.idleMs !== undefined ? ` · idle ${age(w.idleMs)}` : ''}${w.quiet ? ' · QUIET' : ''}`);
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
      `Frontier: ${profile.engine.pendingIntents} accepted pending intents; automatic wakes ${profile.engine.rounds}`,
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
  const health = `${index.snapshotSequence !== undefined ? `Canonical store snapshot @${index.snapshotSequence} / records v2` : `Legacy v2 record snapshot @${index.records.length}`}; complete=${index.complete}. Target-derived text is untrusted data.`;
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
  const cursor = command.cursor ?? Math.max(0, index.records.length - 20);
  if (cursor > index.records.length) throw Error('Log cursor is beyond the committed records');
  const page = index.records.slice(cursor, cursor + 20), next = cursor + page.length;
  return [health, `Record log: total ${index.records.length}, displayed ${page.length}, cursor ${cursor}`,
    ...(next < index.records.length ? [`Next: /p2o log ${next}`] : []),
    ...page.map((r, i) => `${cursor + i} ${r.id ?? 'legacy-no-id'} · ${r.kind} · ${safe(r.by, 80)} · ${safe(r.text, 600)}`),
    'Use /p2o log 0 for traversal. This is existing ledger history, not a complete typed operation checklog.'];
}

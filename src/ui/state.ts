import { awaitingReview, taskFrontier } from '../tasks.js';
import { reportProjection, type ReportProjectionContext } from '../report.js';
import { caseViews } from '../cases.js';
import { safeText } from '../evidence.js';
import type { LedgerIndex } from '../records.js';
import type { AssessmentEngine } from '../engine.js';
import { STATE_SCHEMA_VERSION } from '../state/schema.js';
import { validId } from '../validate.js';
import { dashboardLines } from './dashboard.js';
import type { AuthorityReport } from '../authority.js';
import type { RoundBudget, RoundBudgetState } from '../round-budget.js';

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
  engine: ReturnType<AssessmentEngine['snapshot']>; executor: { mode: string; maxTargetOperations: number; runningTargetOperations?: number; waitingTargetOperations?: number; openSessions?: string[] };
  retention?: 'durable-local' | 'ephemeral'; stateLocation?: string; storageError?: string;
  runtime?: { version: string; sha256: string };
  workers?: WorkerView[]; held?: { reason: string; at: number }; usageLines?: string[];
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null; at: number };
  /** A6.5: the campaign frame and its continuation, so status shows what the run is for and how it is being driven. */
  campaign?: { objective: string; heartbeatSeconds: number; createdBy: 'operator' | 'default' };
  /** P18.5/D47: the round the automatic loop is driving, once one has been admitted. */
  round?: RoundView;
}
/**
 * P18.5/D45/D47/D50: the round in flight as an operator sees it. The number, replacement session, budget state and last
 * lifecycle fact come from the run's own round state and ledger; `steps` counts the owner turns the provider answered. This is
 * a projection only — reading it never wakes the loop, spends a model call or changes a budget.
 */
export interface RoundView {
  round: number; sessionId?: string; state: RoundBudgetState; reason?: string;
  steps: number; elapsedSeconds: number; budget: RoundBudget;
  model?: string; thinking?: string;
  lastFact?: { text: string; ageMs: number };
}
/** Local observation only. `quiet` means no local event for the quiet window while queued/running; it is not failure proof, a timeout or a model wake. */
export interface WorkerView { id: string; role: string; taskId?: string; state: string; commandsUsed: number; idleMs?: number; quiet: boolean; reported: boolean; stopped: boolean }
const age = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h`;
/** P18.5/D47: a wrap and a hard budget stop are different operator situations, so they never render as the same word. */
const ROUND_STATE_TEXT: Record<RoundBudgetState, string> = { open: 'open', wrap: 'wrapping up', exhausted: 'stopped at its budget' };
/**
 * P18.5/D47/D50: one operator line for the round in flight, naming the round, its replacement session, the budget axis that
 * governs it, the routed model and the newest round fact. It is a read-only projection; no field here is authority.
 */
function roundLine(round: RoundView, contextPercent?: number | null): string {
  const budget = round.budget, elapsed = Math.max(0, Math.round(round.elapsedSeconds));
  const steps = budget.steps > 0 ? `${round.steps}/${budget.steps} steps` : `${round.steps} steps (no step limit)`;
  const seconds = budget.seconds > 0 ? `${elapsed}s of ${budget.seconds}s` : `${elapsed}s (no time limit)`;
  const context = contextPercent != null && Number.isFinite(contextPercent) && (budget.contextWrapPercent > 0 || budget.contextHardPercent > 0)
    ? `, context ${Math.round(contextPercent)}% (wrap ${budget.contextWrapPercent}%, hard stop ${budget.contextHardPercent}%)` : '';
  const routing = round.model ? ` | model ${safe(round.model, 80)}${round.thinking ? ` at thinking ${safe(round.thinking, 20)}` : ''}` : '';
  const fact = round.lastFact ? ` | last round fact: ${safe(round.lastFact.text, 240)} (${age(round.lastFact.ageMs)} ago)` : '';
  return safe(`Round: ${round.round}${round.sessionId ? ` in session ${safe(round.sessionId, 80)}` : ' (no replacement session yet)'} — budget ${ROUND_STATE_TEXT[round.state]}${round.reason ? ` (${round.reason})` : ''} | ${steps}, ${seconds}${context}${routing}${fact}`, 900);
}
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
  /** A4: planner/worker target ops, task/claim/validation counters, stalled rounds, mode and the static role matrix. */
  authority: AuthorityReport;
}

/** Legacy v2 projection. Counts are records/tasks, never test cells or validated findings. */
export function statusView(index: LedgerIndex, profile: ViewProfile, context:ReportProjectionContext={}): StatusView {
  const mode = { loopMode: profile.engine.mode, executorMode: profile.executor.mode },
    tasks = taskFrontier(index), report = reportProjection(index,{ ...context, mode }), cases = caseViews(index, context.cases ?? {}),
    authority = report.authority;
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
    candidateClaims: report.counts.candidates, openEntries: report.counts.open, pendingReview,acceptedFindings:report.counts.uniqueAcceptedFindings,pendingCaseReviews:report.counts.pendingCaseReviews,staleCases:report.counts.staleCases,coverageCells:report.counts.coverageCells, retained, authority,
    lines: [title,
      ...(pendingReview ? [`⚠ ${pendingReview} worker report${pendingReview === 1 ? '' : 's'} awaiting Planner review — report alone does not close a goal.`] : []),
      `Target: ${safe(profile.target, 1000)}`,
      ...(profile.held ? [`HOLD: new target commands and worker launches are refused until /p2o release — ${safe(profile.held.reason, 300)}. Commands already running finish; reporting and /p2o stop stay available.`] : []),
      ...(profile.runtime ? [`Runtime: p2o ${safe(profile.runtime.version || 'unknown version', 40)} · ${safe(profile.runtime.sha256, 64).slice(0, 12)} (digest of the entry file + src closure; identifies code, not safety)`] : []), taskLine,
      `Worker slots: ${profile.delegation ? profile.maxWorkers : 0}; target-operation cap: ${profile.executor.maxTargetOperations} (not network rate/connections)`,
      // A7.2: an open session is visible state the operator can close; it is not authority and never outlives the run.
      ...(profile.executor.openSessions?.length ? [`Sessions: ${profile.executor.openSessions.slice(0, 8).map(id => safe(id, 64)).join(', ')}${profile.executor.openSessions.length > 8 ? ` (+${profile.executor.openSessions.length - 8} more)` : ''} — long-lived containers; each command still counts against the operation cap, and stop/finish verifies removal.`] : []),
      `Frontier: ${profile.engine.pendingIntents} accepted pending intents; automatic wakes ${profile.engine.rounds}; stalled rounds ${authority.stalledRounds}`,
      // A6.5: round hygiene is visible — which round, why it was woken, when it started and what drives the next wake.
      ...(profile.campaign || profile.engine.rounds || profile.engine.heartbeat?.seconds ? [`Campaign: ${profile.campaign ? `${safe(profile.campaign.objective, 200)} (${profile.campaign.createdBy})` : 'no campaign record'} | heartbeat ${profile.engine.heartbeat?.seconds ? `${profile.engine.heartbeat.seconds}s` : 'off'}${profile.engine.heartbeat?.nextAt ? ` (next ${safe(profile.engine.heartbeat.nextAt, 40)})` : ''} | rounds ${profile.engine.rounds}${profile.engine.lastWake ? ` | last wake ${profile.engine.lastWake.reason} round ${profile.engine.lastWake.round}` : ' | no automatic wake yet'}${profile.engine.roundStartedAt ? ` | round started ${safe(profile.engine.roundStartedAt, 40)}` : ''}`] : []),
      // P18.5/D47: the round itself — its replacement session, budget axis, routed loadout and newest round fact.
      ...(profile.round ? [roundLine(profile.round, profile.contextUsage?.percent)] : []),
      // A4: the authority line names the measured invariants, the mode that produced the run and the static role matrix.
      `Authority: planner target ops ${authority.plannerTargetOps} (must be 0) | worker target ops ${authority.workerTargetOps} | tasks created ${authority.tasksCreated}, dispatched ${authority.tasksDispatched}${authority.firstDispatchAt ? ` (first ${safe(authority.firstDispatchAt, 40)})` : ''} | claims owner ${authority.ownerClaims} (must be 0), worker ${authority.workerClaims} | validation tasks ${authority.validationTasks} | mode ${authority.mode?.loopMode ?? profile.engine.mode}/${authority.mode?.executorMode ?? profile.executor.mode} | roles planner ${authority.roles.planner}, worker ${authority.roles.worker}, validation ${authority.roles.validation}, reporter ${authority.roles.reporter}`,
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
      ...(profile.campaign ? [`Campaign: ${safe(profile.campaign.objective, 120)} · rounds ${profile.engine.rounds}${profile.engine.lastWake ? ` · ${profile.engine.lastWake.reason}` : ''}`] : []),
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

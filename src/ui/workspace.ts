import type { AssessmentStore } from '../state/store.js';
import { safeText } from '../evidence.js';
import { bundlePath } from '../state/bundle.js';
import { KNOWLEDGE_DOMAINS, type KnowledgeDomain } from '../context.js';
import { normalizeQuery } from '../search.js';
import { validId } from '../validate.js';

export type WorkspaceCommand = { action: 'graph'; id?: string; limit?: number; cursor?:number; export?:boolean } | { action: 'open'; runId: string } | { action: 'recover'; runId: string } | { action: 'reconcile'; runId: string; reason?: string } | { action: 'close' }
  | { action: 'checkpoint'; reason: string } | { action: 'checkpoints'; id?: string }
  | { action: 'artifact'; id: string; offset: number }
  | { action: 'heads'; domain?:KnowledgeDomain; cursor:number; limit:number; status?:string } | { action:'digest' } | { action:'show'; domain:KnowledgeDomain; id:string }
  | { action: 'export'; path: string } | { action: 'import'; path: string } | { action: 'report-export'; path?: string; stix?: boolean; projectKnowledge?: boolean } | { action: 'search'; query: string; cursor: number };
export function parseWorkspaceCommand(args: string): WorkspaceCommand | undefined {
  const trimmed = args.trim();
  const [action, ...parts] = trimmed.split(/\s+/);
  if (action === 'search') {
    // `/p2o search <text> [cursor=N]`: the text is a plain substring (no operators); an explicit `cursor=` keeps numeric queries such as 404 unambiguous.
    const last = parts.at(-1), paged = last !== undefined && /^cursor=\d+$/.test(last), cursor = paged ? Number(last!.slice(7)) : 0;
    if (!Number.isSafeInteger(cursor)) throw Error('Usage: /p2o search <text> [cursor=N]');
    return { action, query: normalizeQuery((paged ? parts.slice(0, -1) : parts).join(' ')), cursor };
  }
  if (action === 'report' && parts[0] === 'export') {
    // `/p2o report` stays the read-only index; only `report export <absolute-dir> [--stix]` writes, human-only, to a new directory.
    let value = trimmed.slice(trimmed.indexOf('export') + 'export'.length).trim();
    // R3.8/R3.9: both flags are opt-in because a STIX consumer and a project-level database are explicit decisions; the default
    // bundle keeps its shape and never writes outside the report directory unless asked.
    const flags = new Set<string>();
    for (const flag of ['--stix', '--project-knowledge']) { if (new RegExp(`(?:^|\\s)${flag}$`).test(value)) { flags.add(flag); value = value.slice(0, -flag.length).trim(); } }
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    // No directory means the default <cwd>/.p2o-reports/report-<run-id>/ (never overwritten).
    return { action: 'report-export', ...(value ? { path: bundlePath(value, 'export') } : {}), ...(flags.has('--stix') ? { stix: true } : {}), ...(flags.has('--project-knowledge') ? { projectKnowledge: true } : {}) };
  }
  if (!['open', 'recover', 'close', 'checkpoint', 'checkpoints', 'artifact', 'export', 'import', 'reconcile', 'graph', 'heads', 'digest', 'show'].includes(action)) return;
  if (action === 'export' || action === 'import') {
    // Human-selected absolute host directory. One optional matching quote pair keeps spaces usable.
    let value = trimmed.slice(action.length).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1,-1);
    if (!value) throw Error(`Usage: /p2o ${action} <absolute-host-directory>`);
    return { action, path: bundlePath(value, action) };
  }
  if(action==='digest'){if(parts.length)throw Error('Usage: /p2o digest (read-only; no ACK)');return {action};}
  if(action==='show'){
    if(parts.length!==2||!(KNOWLEDGE_DOMAINS as readonly string[]).includes(parts[0])||!validId(parts[1]))throw Error('Usage: /p2o show <domain> <id>');
    return {action,domain:parts[0] as KnowledgeDomain,id:parts[1]};
  }
  if(action==='heads'){
    if(parts.length>4||(parts[0]&&parts[0]!=='all'&&!(KNOWLEDGE_DOMAINS as readonly string[]).includes(parts[0]))||parts.slice(1,3).some(value=>!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))||(parts[3]!==undefined&&parts[3].length>80))throw Error('Usage: /p2o heads [domain|all] [cursor default/min 0] [limit default 20, min 1, max 100] [status]');
    const cursor=Number(parts[1]??0),limit=Number(parts[2]??20);if(limit<1||limit>100)throw Error('Knowledge head limit must be 1..100 (default 20)');
    return {action,domain:parts[0]&&parts[0]!=='all'?parts[0] as KnowledgeDomain:undefined,cursor,limit,...(parts[3]!==undefined?{status:parts[3]}:{})};
  }
  if (action === 'close') { if (parts.length) throw Error('close takes no arguments'); return { action }; }
  if (action === 'checkpoint') {
    const reason = parts.join(' ') || 'Human requested checkpoint';
    if (reason.length > 2000) throw Error('Checkpoint label exceeds 2000 characters');
    return { action, reason };
  }
  if (action === 'graph') {
    const number=(value:string|undefined,fallback:number,max:number,min=0)=>{if(value===undefined)return fallback;if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)throw Error('Invalid graph cursor/limit');return Number(value);};
    if (!parts[0]) return { action };
    if(parts[0]==='export'){if(parts.length>3)throw Error('Usage: /p2o graph export [limit 1..500] [cursor]');return {action,export:true,limit:number(parts[1],200,500,1),cursor:number(parts[2],0,Number.MAX_SAFE_INTEGER)};}
    if(parts[0]==='page'){if(parts.length!==2)throw Error('Usage: /p2o graph page <cursor>');return {action,cursor:number(parts[1],0,Number.MAX_SAFE_INTEGER)};}
    if (parts.length>2||!/^asset-[a-f0-9]{24}$/.test(parts[0])) throw Error('Usage: /p2o graph [asset-entity-id] [cursor] | graph export [limit] [cursor]');
    return { action, id: parts[0], ...(parts[1]!==undefined?{cursor:number(parts[1],0,Number.MAX_SAFE_INTEGER)}:{}) };
  }
  if (action === 'reconcile') {
    if (parts.length < 1 || parts.length > 20 || !/^run-[a-z0-9-]{1,75}$/.test(parts[0])) throw Error('Usage: /p2o reconcile <run-id> [reason]');
    const reason = parts.slice(1).join(' ');
    if (reason.length > 2000) throw Error('Reconciliation reason exceeds 2000 characters');
    return { action, runId: parts[0], ...(reason ? {reason} : {}) };
  }
  if (action === 'open' || action === 'recover') {
    if (parts.length !== 1 || !/^run-[a-z0-9-]{1,75}$/.test(parts[0])) throw Error(`Usage: /p2o ${action} <run-id>; no host path or execution authority`);
    return { action, runId: parts[0] };
  }
  if (action === 'checkpoints') {
    if (parts.length > 1 || (parts[0] && !/^checkpoint-[a-z0-9-]{1,65}$/.test(parts[0]))) throw Error('Usage: /p2o checkpoints [checkpoint-id]');
    return { action, id: parts[0] };
  }
  if (parts.length < 1 || parts.length > 2 || !/^artifact-[a-z0-9-]{1,65}$/.test(parts[0]) || (parts[1] && (!/^\d+$/.test(parts[1]) || !Number.isSafeInteger(Number(parts[1]))))) throw Error('Usage: /p2o artifact <artifact-id> [byte-offset]');
  return { action: 'artifact', id: parts[0], offset: Number(parts[1] ?? 0) };
}
const safe = (text: string) => safeText(text);
/** Indexed read-only UI does not materialize cold history or consume any delivery cursor. */
export function knowledgeLines(store:AssessmentStore,command:Extract<WorkspaceCommand,{action:'heads'|'digest'}>):string[]{
  if(command.action==='digest'){
    const packet=store.contextPacket({consumerId:'planner',role:'planner',maxBytes:16*1024});
    return [`Deterministic knowledge digest @${packet.asOfSequence}; ${packet.encodedBytes} bytes; SHA256 ${packet.packetSha256}`,
      `Heads ${packet.counts.heads}, cold retained records ${packet.counts.coldRecords}, unresolved gaps ${packet.counts.openGaps}, pending/stale reviews ${packet.counts.pendingReviews}`,
      `Cursor before ${JSON.stringify(packet.cursorBefore)}; proposed delivery only ${JSON.stringify(packet.cursorAfter)}; NOT ACKED by this human read`,
      `Shown changes/gaps/reviews/relevance: ${packet.changes.length}/${packet.newGaps.length}/${packet.newReviews.length}/${packet.relevant.length}; omitted ${JSON.stringify(packet.omissions)}`,
      ...packet.newGaps.map(row=>`GAP ${row.recordId}: ${safe(row.summary)}`),...packet.newReviews.map(row=>`REVIEW ${row.entityId} ${row.status}: ${safe(row.summary)}`),
      ...packet.relevant.slice(0,10).map(row=>`${row.domain} ${row.entityId} [${row.status}] record=${row.recordId}: ${safe(row.summary)}`),packet.warning];
  }
  const page=store.knowledgePage(command);
  return [`Knowledge heads @${page.asOfSequence}; domain ${command.domain??'all'}${command.status?` status=${command.status}`:''}; cursor ${page.cursor}; matching total ${page.total}, shown ${page.shown}, omitted ${page.omitted}`,
    ...(page.nextCursor!==undefined?[`Next: /p2o heads ${command.domain??'all'} ${page.nextCursor} ${command.limit}${command.status?` ${command.status}`:''}`]:[]),
    ...page.rows.map(row=>`${row.sequence} ${row.domain} ${row.entityId} [${row.status}] record=${row.recordId} by=${row.actorId}: ${safe(row.summary)}`),
    'Current navigation heads only; cold record IDs/history remain retained. Accepted/reported labels are claims, not current proof or permission.',
    ...(store.readOnly?['HISTORICAL — no active authority.']:[])];
}
/** Exact-record detail for one knowledge-head entity: the full stored record, not the bounded list summary. Open one with /p2o heads <domain>. */
export function showLines(store:AssessmentStore,domain:KnowledgeDomain,id:string):string[]{
  const record=store.knowledgeRecord(domain,id);
  if(!record)throw Error(`Unknown ${domain} id in this run`);
  return [`${record.id??id} · ${domain} · kind=${record.kind} · by=${safe(record.by)}`,
    `Summary: ${safe(record.text).slice(0,2000)}`,
    ...(record.surface?[`Surface: ${safe(record.surface)}`]:[]),...(record.risk?[`Risk: ${safe(record.risk)}`]:[]),
    ...(record.refs?.length?[`Refs: ${record.refs.join(', ')}`]:[]),
    `Data: ${safe(JSON.stringify(record.data??{})).slice(0,6000)}`,
    'Full stored record of the current head only; prior revisions are not included — use /p2o log task=<id>/actor=<id> for history.',
    ...(store.readOnly?['HISTORICAL — no active authority.']:[])];
}
/** Bounded human view of the asset graph: counts, latest heads, stale pins; never a proof claim. */
export function graphLines(store: AssessmentStore, id?: string, limit = 20, cursor=0): string[] {
  if (id) {
    const view = store.assetView(id,{since:cursor,limit}), head = view.head as Record<string, unknown>;
    return [`${view.entityId} r${view.revision} ${String(head.kind)}: ${safe(String(head.key))}${head.label ? ` — ${safe(String(head.label))}` : ''}`,
      `Revisions ${view.counts.revisions}; assertions ${view.counts.assertions}; relations ${view.counts.relations}; anchors ${view.counts.anchors}; producers ${view.counts.provenance}; scope ${view.scope}`,
      `History @${view.asOfSequence}; displayed ${view.shown}, omitted ${view.omitted}${view.nextCursor!==undefined?`; next: /p2o graph ${id} ${view.nextCursor}`:''}`, 
      ...view.revisions.slice(-5).map(row => `r${row.revision}: ${safe(JSON.stringify({ label: row.label ?? null, attributes: row.attributes ?? null, anchors: (row.anchors as unknown[] | null)?.length ?? 0 }))}`),
      ...(view.assertions as Array<Record<string, unknown> & {stale:boolean}>).slice(0, limit).map(row => `${row.kind === 'hypothesis' ? `hypothesis[${String(row.status)}]` : 'fact'} ${row.stale ? 'STALE ' : ''}${safe(String(row.statement))} evidence=${(row.evidenceRefs as string[]).length} counter=${((row.counterevidenceRefs ?? []) as string[]).length}`),
      ...(view.relations as Array<Record<string, unknown> & {stale:boolean}>).slice(0, limit).map(row => `${String(row.direction)} ${String(row.kind)} ${row.stale ? 'STALE ' : ''}${String(row.fromId === view.entityId ? row.toId : row.fromId)}`),
      ...view.anchors.slice(0, limit).map(row => `anchor ${String(row.kind)}: ${safe(String(row.value))}${row.artifactId ? ` (${String(row.artifactId)})` : ''}`),
      view.assertions.some(row => row.stale) || view.relations.some(row => row.stale)
        ? 'STALE pins mean the asset changed after the claim; re-validating is required.' : 'No stale pins recorded.',
      'Graph claims are attributed knowledge, not verified findings or permission.'];
  }
  const page = store.graphPage({ limit, since:cursor }), summary=store.graphSummary(page.asOfSequence);
  return [`Asset graph scope ${summary.scope}; heads ${summary.assets}; assertions ${summary.assertions}; relations ${summary.relations}; anchors ${summary.anchors}; @${page.asOfSequence}`,
    `Asset revision page: matching total ${page.total}, displayed ${page.shown}, omitted ${page.omitted}${page.nextCursor!==undefined?`; next: /p2o graph page ${page.nextCursor}`:''}`, 
    ...page.rows.slice(-limit).map(row => `${String(row.entityId)} r${String(row.revision)} ${String(row.kind)}: ${safe(String(row.key))}`),
    'Use /p2o graph <asset-entity-id> for revisions/claims, or /p2o graph export for the bounded JSON+Mermaid rendering.',
    'Stale pins and missing receipts are not permission; the graph never grants scope or authority.'];
}
/** Human export is an actual bounded JSON/Mermaid view, not just an inventory label. */
export function graphExportLines(store:AssessmentStore,limit=200,cursor=0):string[] {
  const view=store.graphExport({limit,since:cursor});
  return [`Graph JSON/Mermaid @${view.asOfSequence}; shown ${JSON.stringify(view.shown)}; omitted ${JSON.stringify(view.omittedByKind)}`,
    ...(view.nextCursor!==undefined?[`Next asset heads: /p2o graph export ${limit} ${view.nextCursor}`]:[]),
    JSON.stringify(view.json,null,2),...view.mermaid.split('\n'),view.warning];
}
/** One bounded human line for the latest attributed reconciliation record, if any. */
export function reconciliationLine(store: AssessmentStore): string | undefined {
  const record = store.records().filter(row => row.kind === 'lifecycle' && row.data?.reconciliation).at(-1);
  if (!record) return;
  const value = record.data!.reconciliation as Record<string, unknown>;
  const list = (key: string) => Array.isArray(value[key]) && (value[key] as unknown[]).length ? (value[key] as unknown[]).slice(0,10).join(',') : '(none)';
  return `Reconciled @${value.asOfSequence} by ${safe(String(value.by ?? record.by))} (${safe(String(value.reason ?? ''))}): running=${list('runningTaskIds')} unknownOps=${list('unknownOperationIds')} — no resume, no authority; record ${record.id}`;
}
/** Human read-only projections. Never return a whole checkpoint snapshot into model context. */
export function checkpointLines(store: AssessmentStore, id?: string): string[] {
  if (!id) {
    const all = store.checkpoints(), shown = all.slice(-20);
    return [`Checkpoints: total ${all.length}, displayed ${shown.length}; ${store.readOnly ? 'HISTORICAL — no active authority' : 'live knowledge only'}`,
      ...shown.map(c => `${c.id} @${c.asOfSequence} integrity=${c.integrityStatus}, data=${c.dataStatus ?? 'unknown'}, retention=${c.retentionStatus}: ${safe(c.reason)}`),
      'Inspect by ID: /p2o checkpoints <checkpoint-id>. Integrity is not proof/currentness.'];
  }
  const view = store.inspectCheckpoint(id), c = view.manifest;
  return [`${c.id} @${c.asOfSequence}: integrity ${view.integrityStatus}; data ${view.dataStatus}; ${view.currentness}; ${view.eventsNewer} newer events`,
    `Run ${c.sourceRunId}; target identity ${c.targetIdentity}; ${c.retentionStatus}`, `Reason: ${safe(c.reason)}`,
    `Snapshot ${c.snapshotBytes} bytes; SHA256 ${c.snapshotSha256}`,
    `Pending reviews (${c.pendingReviews.length}): ${c.pendingReviews.slice(0, 20).join(', ') || '(none)'}`,
    ...(c.planning?[`Planning: goals ${c.planning.goals}, todo ${c.planning.todo}, decisions ${c.planning.decisions}, phase packets ${c.planning.phasePackets}`,
      `Pending phase packets (${c.planning.pendingPhasePacketIds.length}): ${c.planning.pendingPhasePacketIds.slice(0,20).join(', ')||'(none)'}`]:['Planning/phase summary: unknown in this historical checkpoint']),
    ...(c.review?[`Case review: total ${c.review.cases}, unique accepted-current ${c.review.uniqueAcceptedFindings}, duplicates ${c.review.duplicateCases}, pending ${c.review.pendingCases}, stale ${c.review.staleCases}`,
      `Coverage: plans ${c.review.coveragePlans}, cells ${c.review.coverageCells}, stale cells ${c.review.staleCoverageCells}, discovered-unplanned assets ${c.review.discoveredUnplannedAssets}`]:['Case/coverage summary: unknown in this historical checkpoint']),
    `Open gaps (${c.openGapIds.length}): ${c.openGapIds.slice(0, 20).join(', ') || '(none)'}`,
    `In-flight/unknown operations (${c.inFlightOperationIds.length}): ${c.inFlightOperationIds.slice(0, 20).join(', ') || '(none)'}`,
    `Artifacts (${c.artifacts.length}): ${c.artifacts.slice(0, 20).map(a => a.id).join(', ') || '(none)'}`,
    `Missing refs: ${view.missingRefs.join(', ') || '(none)'}`,
    `Partial capture (${c.capturePartialArtifactIds?.length ?? 0}): ${c.capturePartialArtifactIds?.slice(0,20).join(', ') || '(none)'}`,
    `Unavailable capture (${c.captureUnavailableEvidenceIds?.length ?? 0}): ${c.captureUnavailableEvidenceIds?.slice(0,20).join(', ') || '(none)'}`, ...c.omissions,
    'Snapshot is retained knowledge only; no worker/ticket/cookie/queue/request replay or execution authority is restored.'];
}
export interface EventFilter { taskId?: string; actorId?: string; operationId?: string }
export function eventLines(store: AssessmentStore, cursor?: number, filter: EventFilter = {}): string[] {
  const selected = [['task', filter.taskId], ['actor', filter.actorId], ['operation', filter.operationId]].filter((entry): entry is [string, string] => entry[1] !== undefined);
  const suffix = selected.map(([key, value]) => ` ${key}=${value}`).join(''), filtered = selected.length > 0;
  // An unfiltered default stays the last 20 sequence numbers; a filtered default shows the newest matching events, never the newest sequences.
  const page = store.events({ ...(cursor !== undefined ? { since: cursor } : filtered ? { tail: true } : { since: Math.max(0, store.sequence() - 20) }), limit: 20,
    ...(filter.taskId ? { taskId: filter.taskId } : {}), ...(filter.actorId ? { actorId: filter.actorId } : {}), ...(filter.operationId ? { operationId: filter.operationId } : {}) });
  return [`Committed checklog @${page.asOfSequence}; cursor ${page.cursor}; matching total ${page.total}, displayed ${page.shown}, omitted ${page.omitted}${filtered ? `; filter${suffix}` : ''}`,
    ...(page.nextCursor !== undefined ? [`Next: /p2o log ${page.nextCursor}${suffix}`] : []),
    ...(filtered && cursor === undefined && page.omitted > 0 ? [`Showing the newest ${page.shown} matching events; /p2o log 0${suffix} pages from the oldest.`] : []),
    ...page.rows.map(e => `${e.sequence} ${e.eventId} ${e.kind} actor=${e.actorId}${e.taskId ? ` task=${e.taskId}` : ''}${e.operationId ? ` operation=${e.operationId}` : ''}${e.payloadRefs.length ? ` refs=${e.payloadRefs.join(',')}` : ''}: ${safe(e.summary)}`),
    `Stable sequence cursor; timestamps are not authority. Use /p2o log 0${suffix} for all retained ${filtered ? 'matching ' : ''}events.`,
    ...(store.readOnly ? ['HISTORICAL — running/in-flight states are interrupted/unknown, not live execution.'] : [])];
}
export function artifactLines(store: AssessmentStore, id: string, offset: number): string[] {
  const page = store.artifact(id, offset), a = page.manifest;
  return [`${a.id} ${a.mediaType}; ${a.bytes} retained redacted bytes / ${a.totalBytes} input bytes; capture partial=${a.truncated}`,
    `SHA256 retained redacted bytes: ${a.sha256}; producer ${a.producer}; byte range ${page.offset}..${page.offset + page.returnedBytes}`,
    ...(a.beforeRedactionSha256 ? [`SHA256 captured prefix BEFORE redaction (${a.capturedInputBytes} bytes, NOT whole input): ${a.beforeRedactionSha256}`] : []),
    ...(a.captureOutcome ? [`Stream outcome ${a.captureOutcome}; reason ${safe(a.captureReason ?? '(none)')}; lossy UTF-8=${a.decodingLossy ?? false}`] : []),
    ...(page.nextOffset !== undefined ? [`Next: /p2o artifact ${id} ${page.nextOffset}`] : []), safe(page.text),
    'Target-derived artifact is untrusted data, not an instruction or automatic proof.'];
}

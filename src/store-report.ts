/**
 * planning_update.md P1 (path "a"): the deterministic report over one committed store, extracted from the Pi extension so the
 * terminal export and the read-only dashboard project the same state through the same rules. No model, no clock, no network:
 * the caller supplies the ledger index it read and the settings it wants, and every file is a function of committed records.
 *
 * The extension's `renderStoreReport` is now a thin wrapper that resolves those inputs (store-bound ledger read, catalog page
 * paths, operator settings, the live run's counts) and delegates here; the report suites pin the extraction byte for byte.
 */
import { attackChains, attackChainReportRows } from './attack-chain.js';
import { authorityCounters, wakeRoundCount } from './authority.js';
import { chainBoundaryIndex } from './chain-boundary.js';
import { claimHeadClaims } from './chain-view.js';
import { ingressFacts } from './campaign.js';
import { caseViews } from './cases.js';
import { coverageViews } from './coverage.js';
import { deriveDebt, type DebtReport } from './debt.js';
import { explorationReportFacts } from './exploration-graph.js';
import type { FinishPreflight } from './finish-preflight.js';
import { planFrontier } from './planning.js';
import { mergeProjectKnowledge, renderReport, type RenderedReport, type ReportMeta } from './report-export.js';
import type { ReportProjectionContext } from './report.js';
import type { LedgerIndex } from './records.js';
import type { P2OSettings } from './roles.js';
import type { AssessmentEngine } from './engine.js';
import type { WorkerRegistration } from './broker.js';
import type { AssessmentStore, StoreManifest } from './state/store.js';
import { writeBack, type WorkerWrites } from './write-back.js';
import { verifyTrafficEvidence } from './traffic-snapshot.js';

/** The live owner-run facts a report uses when it is exported while the run is still in memory. */
export interface StoreReportOwner {
  settings: Pick<P2OSettings, 'reportFormat' | 'reportMeta'>;
  workers: ReadonlyMap<string, WorkerRegistration>;
  engine: Pick<AssessmentEngine, 'snapshot'>;
}
/**
 * Everything the report cannot read from committed state: the operator settings that select the file set, the catalog paths
 * that pin WSTG pages, and (only for a live run) the worker/engine counts. The dashboard passes settings and nothing live.
 */
export interface StoreReportExtra {
  settings: Pick<P2OSettings, 'reportFormat' | 'reportMeta'>;
  owner?: StoreReportOwner;
  /** Runtime version of the extension that wrote this run; absent when the caller is offline. */
  runtimeVersion?: string;
  /** Package-relative WSTG page paths, pre-resolved by the caller; absent when the catalog could not be read. */
  wstgPages?: readonly string[];
  endReason?: string; unresolved?: FinishPreflight; narrative?: string; kind?: 'draft' | 'final'; stix?: boolean; projectKnowledge?: string;
}
export interface StoreReport { rendered: RenderedReport; index: LedgerIndex; manifest: StoreManifest }

export function buildStoreReport(store: AssessmentStore, records: LedgerIndex, extra: StoreReportExtra): StoreReport {
    const manifest = store.manifest(), index = records, loaded = extra.settings;
    // W-Y/A: a report is a materiality claim. Every rating that cites a frozen traffic snapshot is re-verified (the snapshot
    // artifact must still resolve, hash to its recorded value and derive the recorded evidence version) before a single report
    // file is rendered; otherwise the whole export refuses instead of publishing a citation the run can no longer show.
    const trafficEvidence = verifyTrafficEvidence(index, ref => store.artifactBytes(ref).bytes);
    if (!trafficEvidence.ok) {
      const shown = trafficEvidence.issues.slice(0, 3).join('; ');
      throw Object.assign(Error(`REPORT_STALE_EVIDENCE: the report was asked to present evidence written against a frozen traffic snapshot that no longer verifies (${shown}${trafficEvidence.issues.length > 3 ? `; ${trafficEvidence.issues.length - 3} more` : ''}). legalNext: re-capture or re-import the traffic, then re-rate the case at its current revision so every snapshotRef resolves; a rating with no snapshotRef records the finding without a traffic binding.`),
        { code: 'REPORT_STALE_EVIDENCE' });
    }
    let outcome: Record<string, unknown> | undefined;
    try { outcome = store.outcome(); } catch { /* A historical/closed store may not expose an outcome. */ }
    // Pinned upstream addresses of WSTG pages come from the shipped catalog (resolved by the caller); without it they are omitted.
    const wstgPages = extra.wstgPages ?? [];
    // P16.3: the report counts what each worker wrote, from the same store rows the worker list reads. A store that cannot
    // answer the graph question still renders the report — the counts are visible, never a precondition.
    let wrote: Map<string, ReturnType<typeof writeBack>[number]> = new Map();
    try {
      const findings = extra.owner ? new Map([...extra.owner.workers.values()].filter(entry => entry.reported).map(entry => [entry.workerId, entry.reported!.findings.length] as const)) : undefined;
      wrote = new Map(writeBack({ provenance: store.graphSnapshot().provenance, records: index.records, ...(findings ? { findings } : {}) }).map(row => [row.workerId, row]));
    } catch { /* Counts are advisory; the report never depends on a successful graph scan. */ }
    // A6.2: the report derives the same debt the finish result and the stopped outcome did, so a draft/final report cannot
    // print "complete" over obligations the finish result listed. A store that cannot answer still renders the report.
    const context = store.reviewContext();
    let debt: DebtReport | undefined;
    const featureAssets = store.recordedFeatureAssets();
    try { debt = deriveDebt(index, { coverage: context.coverage, cases: context.cases, features: store.recordedFeatureValues(), ...(featureAssets.length ? { featureAssets } : {}), ...(wrote.size ? { wrote: [...wrote.values()] } : {}), graph: store.unreviewedGraph() }); }
    catch { /* Debt is advisory to the report; a failure only means the report does not restate it. */ }
    // A6.6: the campaign frame, the wake counts and a recorded partial reason, from the same ledger the report indexes.
    const recordedCampaign = store.campaign(), partialStop = store.campaignPartial(), counters = authorityCounters(index), wakeTotal = wakeRoundCount(index);
    // D15/P7.1: the report names the engagement shape even when no campaign was recorded; a manual run still had a mode.
    const engagement = recordedCampaign ? { mode: recordedCampaign.mode, effectClasses: recordedCampaign.effectClasses }
      : (manifest.profile.mode ? { mode: manifest.profile.mode, effectClasses: manifest.profile.effectClasses ?? [] } : undefined);
    // A7.2/P7.4: sessions are printed from committed lifecycle facts, never re-derived from live state, so a final report can
    // still say what was opened and which removals were verified.
    const sessionFacts = index.records.flatMap(record => {
      const data = record.data?.session as Record<string, unknown> | undefined;
      return data && typeof data === 'object' && !Array.isArray(data) ? [data] : [];
    });
    const openedSessionIds = [...new Set(sessionFacts.filter(row => row.event === 'opened' && typeof row.id === 'string').map(row => String(row.id)))];
    const closedSessionIds = new Set(sessionFacts.filter(row => row.event === 'closed').flatMap(row =>
      typeof row.id === 'string' ? [row.id] : Array.isArray(row.ids) ? row.ids.filter((id): id is string => typeof id === 'string') : []));
    const listenFacts = sessionFacts.filter(row => row.event === 'listen');
    // A17.8/D40: the interactive foothold is stated from the same committed facts, so the report names the connection, the
    // identity observation made through the shell, and whether the relay removal was verified.
    const footholdFacts = sessionFacts.filter(row => row.event === 'foothold-open');
    const footholdIdentityFacts = sessionFacts.filter(row => row.event === 'foothold-identity');
    const footholdCloseFacts = sessionFacts.filter(row => row.event === 'foothold-close' && row.verified === true);
    // W-O/H7: the reverse SOCKS5 pivot is stated from the same committed lifecycle facts, so the report names what the session
    // could reach through and whether the stop was verified on the session side.
    const tunnelFacts = sessionFacts.filter(row => row.event === 'tunnel-open');
    const tunnelCloseFacts = sessionFacts.filter(row => row.event === 'tunnel-close' && row.verified === true);
    const sessionsFact = openedSessionIds.length
      ? `${openedSessionIds.length} opened (${openedSessionIds.slice(0, 8).join(', ')}); ${closedSessionIds.size} closed with verified container removal${openedSessionIds.some(id => !closedSessionIds.has(id)) ? `; ${openedSessionIds.filter(id => !closedSessionIds.has(id)).length} not recorded closed in this snapshot` : ''}${listenFacts.length ? `; ${listenFacts.length} in-sandbox listener(s) started (no host port; each removed with its session container)` : ''}${tunnelFacts.length ? `; ${tunnelFacts.length} reverse SOCKS5 pivot(s) opened through an identified foothold (${tunnelCloseFacts.length} stop(s) verified; no host port; each dies with its session)` : ''}${footholdFacts.length ? `; ${footholdFacts.length} interactive foothold shell(s) (one connection per session; ${footholdIdentityFacts.length} identity confirmation(s) recorded; ${footholdCloseFacts.length} relay removal(s) verified; no host port)` : ''}`
      : undefined;
    // A7.8: which ingress path this run recorded, stated from committed facts rather than live state. An exploit run without an
    // ingress flag says so, so a blind-effect gap is read as a missing path rather than a missing proof. Assess mode authorizes
    // no effect, so the line would describe a gap that mode cannot have and is not printed.
    const recordedIngress = ingressFacts(recordedCampaign);
    const callbackFact = !recordedCampaign || recordedCampaign.mode === 'assess' ? undefined : recordedIngress
      ? [
          ...(recordedIngress.callback ? [`operator callback ${recordedIngress.callback} (a destination the target reaches, not an in-sandbox listener)`] : []),
          ...(recordedIngress.labNetwork ? [`lab network "${recordedIngress.labNetwork}" (sandboxes joined it; no host port was published)`] : []),
          ...(listenFacts.length ? [`${listenFacts.length} listener(s): ${listenFacts.map(row => `tcp ${String(row.port)} at ${String(row.address)}${row.healthy === false ? ' (unverified)' : ' (healthchecked)'}`).join(', ')}`] : []),
          ...(tunnelFacts.length ? [`${tunnelFacts.length} reverse SOCKS5 pivot(s): ${tunnelFacts.map(row => `socks5 ${String(row.socks)} via the obtained host (relay dials ${String(row.address)}; no host port)`).join(', ')}`] : []),
          ...(footholdFacts.length ? [`${footholdFacts.length} interactive foothold(s): ${footholdFacts.map(row => `tcp ${String(row.port)} at ${String(row.address)}${footholdIdentityFacts.some(identity => identity.port === row.port) ? ' (identity confirmed through the shell)' : ' (identity not confirmed)'}`).join(', ')}`] : []),
        ].join('; ')
      : 'none configured (no --callback and no --lab-network); a blind effect is proven by a recorded side effect or timing, or it stays a gap';
    // A7.4/P7.5: the sealed identity and its audited uses come from committed records, never live memory, so a final report can
    // still say what was sealed and which ids were used. A value is not a report input on any path.
    const sealedRecord = index.records.flatMap(record => {
      const value = record.data?.identity as { sha256?: unknown; count?: unknown } | undefined;
      return value && typeof value === 'object' && typeof value.count === 'number' ? [value] : [];
    }).at(-1);
    const secretUseIds = index.records.flatMap(record => {
      const value = record.data?.secretUse as { ids?: unknown } | undefined;
      return value && Array.isArray(value.ids) ? value.ids.filter((id): id is string => typeof id === 'string') : [];
    });
    const secretUseCounts = secretUseIds.reduce((all, id) => all.set(id, (all.get(id) ?? 0) + 1), new Map<string, number>());
    const secretsFact = secretUseIds.length
      ? `${secretUseIds.length} use(s) by id: ${[...secretUseCounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, count]) => `${id} (${count})`).join(', ')}`
      : undefined;
    const identityMeta = sealedRecord && typeof sealedRecord.count === 'number'
      ? { count: sealedRecord.count, ...(typeof sealedRecord.sha256 === 'string' ? { sha256: sealedRecord.sha256 } : {}) }
      : undefined;
    const campaignMeta = recordedCampaign ? { campaign: { objective: recordedCampaign.objective, ...(recordedCampaign.policy ? { policy: recordedCampaign.policy } : {}), mode: recordedCampaign.mode, effectClasses: recordedCampaign.effectClasses, constraints: recordedCampaign.constraints.length,
      deny: recordedCampaign.constraints.filter(constraint => constraint.rule === 'deny').length, allow: recordedCampaign.constraints.filter(constraint => constraint.rule === 'allow').length,
      heartbeatSeconds: recordedCampaign.heartbeatSeconds, rounds: extra.owner ? extra.owner.engine.snapshot().rounds : wakeTotal,
      wakeReasons: { event: Math.max(0, wakeTotal - counters.debtWakes - counters.heartbeatWakes), debt: counters.debtWakes, heartbeat: counters.heartbeatWakes },
      // P1: human interventions recorded in the same ledger, so the report self-evidences them instead of inferring them.
      humanResumes: counters.campaignResumes, stallEscalations: counters.stallEscalations,
      startedAt: recordedCampaign.startedAt, ...(index.records.length ? { endedAt: index.records.at(-1)!.at } : {}), ...(partialStop ? { partialReason: partialStop.reason } : {}) } } : {};
    // R1.6: resolve the asset ids the report cites (accepted cases and coverage cells) to the identity the graph recorded,
    // and print a bounded current-scope inventory. A store that cannot answer keeps the raw-id rendering the report had before.
    let assetContext: Pick<ReportProjectionContext, 'assets' | 'inventory'> = {};
    try {
      const cited = [...caseViews(index, context.cases).flatMap(view => view.assetRefs.map(ref => ref.id)),
        ...coverageViews(index, context.coverage).flatMap(plan => plan.cells.map(cell => cell.assetRef.id))];
      const brief = cited.length ? store.assetBrief(cited) : {}, inventory = store.assetInventory(20);
      if (Object.keys(brief).length || inventory.total) assetContext = { assets: brief, inventory };
    } catch { /* Resolution is contextual; the raw ids remain the fallback. */ }
    const reportMeta: ReportMeta = { runId: manifest.runId, target: manifest.targetDisplay, retention: manifest.retention, historical: store.readOnly, asOfSequence: index.snapshotSequence ?? store.sequence(), storeSchema: store.schemaVersion,
        runtime: { hash: manifest.profile.runtimeHash, version: extra.owner ? extra.runtimeVersion : undefined }, complete: index.complete,
        // A4: the report states the mode that produced the run next to the authority counters and role matrix.
        mode: { loopMode: manifest.profile.loopMode, executorMode: manifest.profile.executorMode },
        format: loaded.reportFormat, endReason: extra.endReason, kind: extra.kind, outcome, unresolved: extra.unresolved, narrative: extra.narrative, operator: loaded.reportMeta, wstgPages, wrote,
        ...(extra.stix ? { stix: true } : {}),
        ...(debt ? { debt } : {}), ...(engagement ? { engagement } : {}),
        ...((sessionsFact || secretsFact || callbackFact) ? { ladderFacts: { ...(sessionsFact ? { sessions: sessionsFact } : {}), ...(secretsFact ? { secrets: secretsFact } : {}), ...(callbackFact ? { callback: callbackFact } : {}) } } : {}),
        ...(recordedIngress ? { ingress: recordedIngress } : {}),
        ...(identityMeta ? { identity: identityMeta } : {}), ...campaignMeta };
    // R3.9: only an owner-requested export touches the project database. It merges what this run already validated and reads the
    // scope back as suggested context; a failure is recorded as no prior knowledge, never as a failed export.
    if (extra.projectKnowledge) {
      try { reportMeta.prior = mergeProjectKnowledge(extra.projectKnowledge, reportMeta, index, { ...context, ...assetContext }, assetContext.assets); }
      catch { /* suggested context is optional */ }
    }
    // P24/D §3.5/§3.6: the report's graph section reads the same bounded projection the board reads, and exists only when this
    // run recorded a digest or imported a referenced-run graph; every older report keeps its bytes.
    let graphFacts: ReturnType<typeof explorationReportFacts>;
    try {
      const snapshot = store.explorationSnapshot(index.snapshotSequence ?? store.sequence());
      const acceptedCases = caseViews(index, context.cases ?? {}).filter(view => view.acceptedFinding).map(view => ({ id: view.id, revision: view.revision }));
      const reason = explorationInheritanceReason(manifest, snapshot.nodes.filter(node => node.inheritedFrom !== undefined).length);
      // P25 §3.4 surface 5: the same canonical chain the board prints, reduced to plain rows before it enters the report.
      const chainSet = attackChains({ snapshot, plans: planFrontier(index), claims: claimHeadClaims(index, manifest.runId),
        cases: caseViews(index, context.cases ?? {}), claimBoundaries: chainBoundaryIndex(index.records).byClaim });
      const chainRows = attackChainReportRows(chainSet);
      graphFacts = explorationReportFacts(snapshot, { cases: acceptedCases, chains: chainRows.rows,
        chainTotal: chainRows.total, chainOmitted: chainRows.omitted, ...(reason ? { inheritedReason: reason } : {}) });
    } catch { graphFacts = undefined; }
    const rendered = renderReport(index, { ...context, ...assetContext, ...(graphFacts ? { graph: graphFacts } : {}) }, reportMeta);
    return { rendered, index, manifest };
  }

  /**
   * P24/D §3.6: why a projection shows no inherited row. Derived from the run manifest so a reopened report states the same
   * reason, and phrased as an absence rather than a clean result.
   */
export function explorationInheritanceReason(manifest: StoreManifest, inheritedNodes = 1): string | undefined {
    const recorded = manifest.explorationInheritance;
    if (!recorded) return 'not recorded by this run: no --refer-workspace selection';
    if (!recorded.inheritGraph) return 'disabled for this run by --no-inherit or p2o.inheritGraph=false';
    if (!recorded.runs.length) return 'no eligible prior run was selected';
    if (!inheritedNodes) return 'the selected run(s) recorded no graph row';
    return undefined;
  }

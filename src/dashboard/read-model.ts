/**
 * planning_update.md P1 (path "a"): the read-only read model behind the dashboard data tree.
 *
 * Inputs are two directories the operator already has — committed stores (`<stateRoot>/<runId>/assessment.sqlite`) and
 * exported report bundles (`report-manifest.json`) — and every output is a bounded, deterministic function of what is on disk
 * at the moment of the scan. The model never writes, never opens a store writable, never reads a clock and never calls a model.
 *
 * Two scopes are kept apart on purpose: `cases` shows every case a retained store holds, while `findings` is the same
 * accepted-current projection the report emits (through `buildStoreReport`, so the dashboard and the report cannot disagree).
 * A report-only run (ephemeral store cleaned) has accepted-current findings but no full case list, and the payload says so.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { caseViews, type CaseView } from '../cases.js';
import { FINDING_SEVERITIES } from '../case-types.js';
import { cvssScore } from '../cvss.js';
import { FINDING_ID_PATTERN } from '../finding-fingerprint.js';
import { EXPLORATION_GRAPH_VERSION, explorationNodeText } from '../exploration-graph.js';
import { indexRecords, type LedgerIndex } from '../records.js';
import { findingReproduction, type FindingReproductionRow } from '../report-export.js';
import { AssessmentStore } from '../state/store.js';
import { buildStoreReport } from '../store-report.js';
import { sha256Hex, validId } from '../validate.js';
import {
  DASHBOARD_FORMAT, DASHBOARD_FORMAT_VERSION, DASHBOARD_LABELS, DASHBOARD_LIMITS, DASHBOARD_RUN_FORMAT,
  dashboardNodeBody, dashboardSeverityRank, dashboardText, dashboardWorstSeverity,
  type DashboardAnchor, type DashboardArtifactRef, type DashboardCaseRow, type DashboardConflict, type DashboardEdge,
  type DashboardFindingAggregate, type DashboardFindingChain, type DashboardFindingChainStep, type DashboardFindingContradiction,
  type DashboardFindingRemediation, type DashboardFindingRetest, type DashboardFindingRow, type DashboardFindingTraffic,
  type DashboardFindingWstg, type DashboardGraph, type DashboardIndexFile, type DashboardLimits,
  type DashboardNode, type DashboardOccurrence, type DashboardRunFile, type DashboardRunOmitted, type DashboardRunSummary,
  type DashboardSource, type DashboardTotals, type DashboardWarning,
} from './contract.js';
import { safeText } from '../evidence.js';

/** A root the caller wants scanned; `optional` roots are the CLI defaults that may not exist yet. */
export interface DashboardSourceRoot { path: string; optional?: boolean }
export interface DashboardBuildInput {
  stateRoots?: readonly DashboardSourceRoot[];
  reportRoots?: readonly DashboardSourceRoot[];
  /** Keep only these run ids (after discovery); an absent or empty list keeps every discovered run. */
  runs?: readonly string[];
  limits?: Partial<DashboardLimits>;
  /** Collect the bounded artifact bodies cited by the findings/cases (snapshot mode needs them; live mode never does). */
  artifacts?: boolean;
}
/** A bounded, redacted artifact body a snapshot copies; `ref` is what the data tree lists. */
export interface DashboardArtifactBody { runId: string; artifactId: string; bytes: Buffer; ref: DashboardArtifactRef }
export interface DashboardBuild { index: DashboardIndexFile; runs: DashboardRunFile[]; artifacts: DashboardArtifactBody[] }

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const integer = (value: unknown, fallback: number): number => Number.isSafeInteger(value) ? Number(value) : fallback;
const byName = (left: { name: string }, right: { name: string }): number => left.name.localeCompare(right.name);
const safeStrings = (value: unknown, limit: number, max: number): string[] =>
  (Array.isArray(value) ? value : []).flatMap(item => { const text = dashboardText(item, max); return text ? [text] : []; }).slice(0, limit);

/** An absolute, normalized root path; the CLI defaults are joined from the cwd so the tree does not depend on it. */
const absolutize = (value: string): string | undefined => {
  if (typeof value !== 'string' || !value.length || !isAbsolute(value)) return undefined;
  const normalized = value.normalize('NFC');
  if (normalized.length > 4096 || /[\x00-\x1f\x7f]/.test(normalized)) return undefined;
  return resolve(normalized);
};

const emptyGraph = (runId: string, asOfSequence: number): DashboardGraph =>
  ({ label: DASHBOARD_LABELS.projection, runId, asOfSequence, graphVersion: 0, nodes: [], edges: [], anchors: [],
    counts: { nodes: 0, edges: 0, anchors: 0 }, unresolved: 0, overflow: 0, chainOrderTruncated: 0, truncated: false });

// ---------------------------------------------------------------------------------------------------------------------
// findings.json parsing: the report's own bounded rows, validated field by field so a damaged bundle cannot inject a shape
// the client did not expect. Anything that fails validation is dropped and the drop is counted, never silently accepted.
// ---------------------------------------------------------------------------------------------------------------------
const severityOf = (value: unknown): string | null => typeof value === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(value) ? value : null;
const cvssOf = (value: unknown): { vector: string; baseScore: number; severity: string } | null => {
  const row = record(value);
  return row && typeof row.vector === 'string' && typeof row.baseScore === 'number' && typeof row.severity === 'string'
    ? { vector: row.vector, baseScore: row.baseScore, severity: row.severity } : null;
};
/** Evidence prose is kept as text (safeText keeps newlines and redacts), bounded by the report's own per-field caps. */
const evidenceText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string' || !value.length) return null;
  const text = safeText(value);
  if (!text.length) return null;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};
const evidenceJson = (value: unknown, bytes: number): Record<string, unknown> | null => {
  const row = record(value);
  return row && Buffer.byteLength(JSON.stringify(row)) <= bytes ? row : null;
};
const wstgOf = (value: unknown): DashboardFindingWstg[] => (Array.isArray(value) ? value : []).slice(0, 48).flatMap(item => {
  if (typeof item === 'string') { const key = dashboardText(item, 40); return key ? [{ key, page: null }] : []; }
  const row = record(item), key = dashboardText(row?.key, 40);
  return key ? [{ key, page: dashboardText(row?.page, 500) ?? null }] : [];
});
const trafficOf = (value: unknown): DashboardFindingTraffic[] => (Array.isArray(value) ? value : []).slice(0, 24).flatMap(item => {
  const row = record(item), role = dashboardText(row?.role, 40), snapshotRef = dashboardText(row?.snapshotRef, 80);
  return role && snapshotRef && Number.isSafeInteger(row?.position) ? [{ role, position: Number(row!.position), snapshotRef }] : [];
});
const retestOf = (value: unknown): DashboardFindingRetest | null => {
  const row = record(value);
  if (!row || typeof row.verdict !== 'string') return null;
  return { verdict: row.verdict, caseRevision: integer(row.caseRevision, 0), current: row.current === true,
    reason: evidenceText(row.reason, 1000) ?? '', evidenceRefs: safeStrings(row.evidenceRefs, 16, 80),
    provenance: dashboardText(row.provenance, 40) ?? null, retesters: safeStrings(row.retesters, 16, 80) };
};
const remediationOf = (value: unknown): DashboardFindingRemediation => {
  const row = record(value);
  return { status: dashboardText(row?.status, 40) ?? 'unknown', reason: evidenceText(row?.reason, 1000) ?? '', steps: evidenceText(row?.steps, 2000) };
};
const contradictionsOf = (value: unknown): DashboardFindingContradiction[] => (Array.isArray(value) ? value : []).slice(0, 16).flatMap(item => {
  const row = record(item), evidenceRef = dashboardText(row?.evidenceRef, 80), status = dashboardText(row?.status, 40);
  return evidenceRef && status ? [{ evidenceRef, status }] : [];
});
function chainOf(value: unknown): DashboardFindingChain | null {
  const row = record(value), objective = evidenceText(row?.objective, 600);
  if (!row || !objective) return null;
  const impact = record(row.impact);
  const steps = (Array.isArray(row.steps) ? row.steps : []).slice(0, 20).flatMap((item): DashboardFindingChainStep[] => {
    const step = record(item), text = evidenceText(step?.step, 400);
    if (!step || !text) return [];
    return [{ order: integer(step.order, 0), step: text, claimRef: dashboardText(step.claimRef, 80) ?? null,
      gained: safeStrings(step.gained, 8, 80), needs: safeStrings(step.needs, 8, 80),
      effect: dashboardText(step.effect, 40) ?? null, reach: evidenceJson(step.reach, 600) }];
  });
  const scored = impact && typeof impact.vector === 'string' && typeof impact.score === 'number' && typeof impact.severity === 'string' && typeof impact.effect === 'string'
    ? { vector: impact.vector, score: impact.score, severity: impact.severity, effect: impact.effect } : null;
  return { objective, demonstratedThrough: Number.isSafeInteger(row.demonstratedThrough) ? Number(row.demonstratedThrough) : null, impact: scored, steps };
}
const capturesOf = (value: unknown): FindingReproductionRow['captures'] => (Array.isArray(value) ? value : []).slice(0, 4).flatMap(item => {
  const row = record(item);
  return row && typeof row.id === 'string' && typeof row.bytes === 'number' && typeof row.sha256 === 'string'
    ? [{ id: row.id, bytes: row.bytes, sha256: row.sha256, partial: row.partial === true }] : [];
});
function reproductionOf(value: unknown): FindingReproductionRow[] {
  return (Array.isArray(value) ? value : []).slice(0, 5).flatMap(item => {
    const row = record(item), evidenceId = dashboardText(row?.evidenceId, 80);
    if (!row || !evidenceId) return [];
    const role = dashboardText(row.role, 40), note = dashboardText(row.note, 200);
    return [{ evidenceId, ...(role ? { role } : {}), ...(note ? { note } : {}), available: row.available === true,
      operation: dashboardText(row.operation, 60) ?? null, by: dashboardText(row.by, 80) ?? null, exitCode: row.exitCode ?? null,
      input: evidenceText(row.input, 700), output: evidenceText(row.output, 500), truncated: row.truncated === true, captures: capturesOf(row.captures) }];
  });
}

/** One `findings.json` item at the report's evidence detail; null when the item does not identify a case and a title at all. */
function findingRow(value: unknown): DashboardFindingRow | undefined {
  const row = record(value), caseId = dashboardText(row?.caseId, 80), title = dashboardText(row?.title, 300);
  if (!row || !caseId || !title) return undefined;
  const findingId = typeof row.findingId === 'string' && FINDING_ID_PATTERN.test(row.findingId) ? row.findingId : null;
  const remediation = remediationOf(row.remediation);
  return {
    findingId, identity: findingId ? 'findingId' : 'fallback',
    caseId, caseRevision: integer(row.revision, 0), title,
    severity: severityOf(row.severity), verdict: dashboardText(row.verdict, 40) ?? 'unknown',
    reviewStatus: dashboardText(row.reviewStatus, 40) ?? 'pending', currentness: dashboardText(row.currentness, 40) ?? 'unknown',
    accepted: true,
    independentValidationCurrent: row.independentValidationCurrent === true,
    independenceReason: dashboardText(row.independenceReason, 600) ?? null,
    policyKey: dashboardText(row.policyKey, 160) ?? '',
    rootCauseKey: dashboardText(row.rootCauseKey, 160) ?? null,
    remediationStatus: remediation.status, remediation,
    retest: retestOf(row.retest),
    cvss: cvssOf(row.cvss), cwe: safeStrings(row.cwe, 16, 40),
    wstg: wstgOf(row.wstg), techniques: safeStrings(row.techniques, 16, 40), assets: safeStrings(row.assets, 8, 80),
    severityBasis: evidenceText(row.severityBasis, 1000), likelihood: evidenceText(row.likelihood, 800), impact: evidenceText(row.impact, 800),
    ratingLimitations: evidenceText(row.ratingLimitations, 2000), ratingProvenance: dashboardText(row.ratingProvenance, 40) ?? null,
    ratingFlags: safeStrings(row.ratingFlags, 16, 40),
    evidenceVersion: dashboardText(row.evidenceVersion, 80) ?? null, traffic: trafficOf(row.traffic),
    claims: safeStrings(row.claims, 20, 80), independentEvidence: safeStrings(row.independentEvidence, 20, 80),
    references: safeStrings(row.references, 20, 200), contradictions: contradictionsOf(row.contradictions),
    limitations: evidenceText(row.limitations, 2000), independenceWaiver: evidenceText(row.independenceWaiver, 300),
    chain: chainOf(row.chain), time: null,
    reproduction: reproductionOf(row.reproduction),
  };
}

/** Parse and validate one `p2o-findings` body. The run id must match the manifest the caller already trusted. */
function parseFindings(value: unknown, runId: string, warnings: DashboardWarning[], source: 'store' | 'report'): DashboardFindingRow[] {
  const body = record(value);
  if (!body || body.format !== 'p2o-findings' || integer(body.version, 0) !== 2 || body.runId !== runId) {
    warnings.push({ code: 'findings-format-invalid', runId, detail: `${source} findings are not a p2o-findings v2 body for this run` });
    return [];
  }
  const items = Array.isArray(body.findings) ? body.findings : [];
  const rows = items.flatMap(item => { const row = findingRow(item); return row ? [row] : []; });
  if (rows.length !== items.length) warnings.push({ code: 'findings-row-invalid', runId, detail: `${items.length - rows.length} finding row(s) of ${items.length} were not a valid p2o findings item and were dropped` });
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// Store scan: one read-only open per run, the same bounded derivation the store uses, no write path of any kind.
// ---------------------------------------------------------------------------------------------------------------------
interface LoadedStore {
  runId: string; summary: DashboardRunSummary; graph: DashboardGraph;
  cases: DashboardCaseRow[]; casesTotal: number; findings: DashboardFindingRow[];
  artifacts: DashboardArtifactBody[];
}

const readOutcome = (store: AssessmentStore): Record<string, unknown> | undefined => { try { return store.outcome(); } catch { return undefined; } };

/** SQLite refuses a reader while a writer holds its exclusive lock (the store opens with `busy_timeout=0`). */
const isBusy = (error: unknown): boolean => /SQLITE_BUSY|database is locked/i.test(messageOf(error));
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export const DASHBOARD_BUSY_ATTEMPTS = 3;
export const DASHBOARD_BUSY_RETRY_MS = 60;

/** A lock held for the whole read is stated as a row, never as an absent run or as a clean empty one. */
function busyStore(runId: string, warnings: DashboardWarning[]): LoadedStore {
  warnings.push({ code: 'store-busy', runId, detail: `a concurrent writer held the store lock for ${DASHBOARD_BUSY_ATTEMPTS} read attempts; the run is listed without data and refreshes on the next poll` });
  const summary: DashboardRunSummary = {
    runId, source: 'store', retention: 'unknown', target: null, targetKind: null, mode: null,
    startedAt: null, lastRecordAt: null, sequence: null, asOfSequence: null, schemaVersion: null, graphVersion: null,
    complete: null, endReason: null, outcome: null, live: true, busy: true, records: 0,
    counts: { nodes: 0, edges: 0, anchors: 0, cases: 0, findingsAccepted: 0 }, warnings: [],
  };
  return { runId, summary, graph: emptyGraph(runId, 0), cases: [], casesTotal: 0, findings: [], artifacts: [] };
}

/** The retained artifact bodies cited by the served findings and case detail: bounded per run and per body, never searched. */
function citedArtifacts(store: AssessmentStore, runId: string, findings: readonly DashboardFindingRow[], cases: readonly DashboardCaseRow[], limits: DashboardLimits, warnings: DashboardWarning[]): DashboardArtifactBody[] {
  const cited: string[] = [];
  for (const row of [...findings, ...cases]) for (const step of row.reproduction) for (const capture of step.captures) if (!cited.includes(capture.id)) cited.push(capture.id);
  const bodies: DashboardArtifactBody[] = [];
  for (const artifactId of cited.slice(0, limits.artifactsPerRun)) {
    if (!validId(artifactId)) continue;
    try {
      const { bytes } = store.artifactBytes(artifactId);
      const copied = bytes.subarray(0, limits.artifactBytes);
      bodies.push({ runId, artifactId, bytes: Buffer.from(copied),
        ref: { artifactId, bytes: copied.length, sha256: sha256Hex(copied), truncated: copied.length < bytes.length, file: `artifacts/${runId}/${artifactId}.txt` } });
    } catch (error) { warnings.push({ code: 'artifact-unreadable', runId, detail: `a cited artifact could not be read: ${messageOf(error)}` }); }
  }
  if (cited.length > limits.artifactsPerRun) warnings.push({ code: 'artifacts-truncated', runId, detail: `${cited.length - limits.artifactsPerRun} cited artifact(s) beyond the ${limits.artifactsPerRun}-per-run bound were not copied` });
  return bodies;
}

function graphOf(store: AssessmentStore, runId: string, sequence: number): DashboardGraph {
  const projection = store.derivedExploration(sequence);
  return {
    label: DASHBOARD_LABELS.projection, runId, asOfSequence: sequence, graphVersion: EXPLORATION_GRAPH_VERSION,
    nodes: projection.nodes.map((node): DashboardNode => ({ id: node.id, kind: node.kind, state: node.state, entityId: node.entityId,
      text: explorationNodeText(node), ...(node.recordId ? { recordId: node.recordId } : {}), ...(node.inheritedFrom ? { inherited: node.inheritedFrom } : {}),
      ...dashboardNodeBody(node.body) })),
    edges: projection.edges.map((edge): DashboardEdge => ({ srcId: edge.srcId, rel: edge.rel, dstId: edge.dstId, ...(edge.inheritedFrom ? { inherited: edge.inheritedFrom } : {}) })),
    anchors: projection.anchors.map((anchor): DashboardAnchor => ({ nodeId: anchor.nodeId, assetEntity: anchor.assetEntity, ...(anchor.inheritedFrom ? { inherited: anchor.inheritedFrom } : {}) })),
    counts: { nodes: projection.nodes.length, edges: projection.edges.length, anchors: projection.anchors.length },
    unresolved: projection.unresolved, overflow: projection.overflow, chainOrderTruncated: projection.chainOrderTruncated ?? 0, truncated: false,
  };
}

function caseRow(view: CaseView, index: LedgerIndex): DashboardCaseRow {
  const finding = view.finding, score = cvssScore(finding?.cvssVector);
  const likelihood = dashboardText(finding?.likelihood, 400), impact = dashboardText(finding?.impact, 400);
  return {
    id: view.id, revision: view.revision, title: dashboardText(view.title, 300) ?? view.id,
    verdict: view.verdict, reviewStatus: view.reviewStatus, currentness: view.currentness, accepted: view.acceptedFinding,
    canonicalCaseId: view.canonicalCaseId, ...(view.duplicateOf ? { duplicateOf: view.duplicateOf } : {}),
    staleReasons: view.staleReasons.slice(0, 40).flatMap(item => { const line = dashboardText(item, 200); return line ? [line] : [] }),
    independentCurrent: view.independentCurrent, readyToRate: view.readyToRate,
    severity: severityOf(finding?.severity), ...(likelihood ? { likelihood } : {}), ...(impact ? { impact } : {}),
    cvss: score ? { vector: score.vector, baseScore: score.score, severity: score.severity } : null, cwe: finding?.cwe ?? [],
    policyKey: view.policyKey, ...(view.rootCauseKey ? { rootCauseKey: view.rootCauseKey } : {}),
    claimRefs: view.claimRefs.slice(0, 20),
    assetRefs: view.assetRefs.slice(0, 10).map(ref => ({ id: ref.id, ...(ref.revision !== undefined ? { revision: ref.revision } : {}) })),
    taskRefs: view.taskRefs.slice(0, 20).map(ref => ({ taskId: ref.taskId, ...(ref.revision !== undefined ? { revision: ref.revision } : {}) })),
    remediation: { status: view.remediation.status, reason: dashboardText(view.remediation.reason, 1000) ?? '' },
    retest: view.retest ? { verdict: view.retest.verdict, current: view.retestCurrent === true } : null,
    ...(view.ratedRevision !== undefined ? { ratedRevision: view.ratedRevision } : {}), ...(view.ratingCurrent !== undefined ? { ratingCurrent: view.ratingCurrent } : {}),
    recordId: view.recordId, time: index.byId.get(view.recordId)?.at ?? null,
    reproduction: findingReproduction(view, index),
  };
}

/** The report's accepted-current projection through the shared builder: the dashboard cannot disagree with `findings.json`. */
function storeFindings(store: AssessmentStore, index: LedgerIndex, runId: string, warnings: DashboardWarning[]): DashboardFindingRow[] {
  let report;
  try { report = buildStoreReport(store, index, { settings: { reportFormat: 2 } }); }
  catch (error) { warnings.push({ code: 'report-projection-refused', runId, detail: messageOf(error) }); return []; }
  const file = report.rendered.files.find(item => item.name === 'findings.json');
  if (!file) { warnings.push({ code: 'report-no-findings', runId, file: 'findings.json', detail: 'the report projection emitted no findings.json' }); return []; }
  let body: unknown;
  try { body = JSON.parse(file.body); }
  catch { warnings.push({ code: 'report-findings-invalid', runId, file: 'findings.json', detail: 'the projection emitted a findings.json body that does not parse' }); return []; }
  return parseFindings(body, runId, warnings, 'store');
}

async function loadStore(root: string, runId: string, limits: DashboardLimits, warnings: DashboardWarning[], collectArtifacts: boolean): Promise<LoadedStore | undefined> {
  for (let attempt = 1; attempt <= DASHBOARD_BUSY_ATTEMPTS; attempt++) {
    let store: AssessmentStore | undefined;
    try {
      store = AssessmentStore.open(root, runId, { readOnly: true });
      // The dashboard is a viewer: a store handle that is not read-only is a bug, not a degraded mode.
      if (store.readOnly !== true) throw Error('the dashboard opened a store that is not read-only');
      if (!store.compatible) { warnings.push({ code: 'store-schema', runId, detail: `state schema ${store.schemaVersion} is not this build's; the run is listed as metadata only` }); return undefined; }
      const manifest = store.manifest(), sequence = store.sequence(), outcome = readOutcome(store);
      const index: LedgerIndex = { ...indexRecords(store.records(), runId), snapshotSequence: sequence };
      const context = store.reviewContext();
      let cases: DashboardCaseRow[] = [], casesTotal = 0;
      try { const views = caseViews(index, context.cases); casesTotal = views.length; cases = views.slice(0, limits.casesPerRun).map(view => caseRow(view, index)); }
      catch (error) { warnings.push({ code: 'case-projection-failed', runId, detail: messageOf(error) }); }
      let graph: DashboardGraph;
      try { graph = graphOf(store, runId, sequence); }
      catch (error) { graph = emptyGraph(runId, sequence); warnings.push({ code: 'graph-derivation-failed', runId, detail: messageOf(error) }); }
      const findings = storeFindings(store, index, runId, warnings);
      // The report lists no per-finding time; the case record has one, and the aggregate's first/last seen depends on it.
      const caseTimes = new Map(cases.map(row => [`${row.id}\u0000${row.revision}`, row.time]));
      for (const row of findings) row.time = caseTimes.get(`${row.caseId}\u0000${row.caseRevision}`) ?? null;
      const artifacts = collectArtifacts ? citedArtifacts(store, runId, findings, cases, limits, warnings) : [];
      const first = index.records[0]?.at ?? null, last = index.records.at(-1)?.at ?? null;
      const summary: DashboardRunSummary = {
        runId, source: 'store', retention: manifest.retention,
        target: dashboardText(manifest.targetDisplay, 200) ?? null, targetKind: manifest.targetKind, mode: manifest.profile.mode ?? null,
        startedAt: first, lastRecordAt: last, sequence, asOfSequence: sequence, schemaVersion: store.schemaVersion, graphVersion: graph.graphVersion,
        complete: index.complete, endReason: dashboardText(outcome?.reason, 300) ?? null,
        outcome: dashboardText(outcome?.assessmentOutcome, 40) ?? null, live: outcome === undefined,
        records: index.records.length,
        counts: { nodes: graph.counts.nodes, edges: graph.counts.edges, anchors: graph.counts.anchors, cases: casesTotal, findingsAccepted: findings.length },
        warnings: [],
      };
      return { runId, summary, graph, cases, casesTotal, findings, artifacts };
    } catch (error) {
      const busy = isBusy(error);
      if (busy && attempt < DASHBOARD_BUSY_ATTEMPTS) { try { store?.close(); } catch { /* nothing was written */ } await delay(attempt * DASHBOARD_BUSY_RETRY_MS); continue; }
      if (busy) return busyStore(runId, warnings);
      warnings.push({ code: 'store-unreadable', runId, detail: messageOf(error) });
      return undefined;
    } finally { try { store?.close(); } catch { /* a read-only handle cannot change committed state. */ } }
  }
  return busyStore(runId, warnings);
}

// ---------------------------------------------------------------------------------------------------------------------
// Report-bundle scan: the manifest is trusted only after the file listing matches the bytes on disk (size + sha256).
// ---------------------------------------------------------------------------------------------------------------------
interface LoadedReport { runId: string; summary: DashboardRunSummary; findings: DashboardFindingRow[] }

async function loadReport(directory: string, warnings: DashboardWarning[]): Promise<LoadedReport | undefined> {
  let manifest: Record<string, unknown> | undefined;
  try { manifest = record(JSON.parse(await readFile(join(directory, 'report-manifest.json'), 'utf8'))); }
  catch (error) { warnings.push({ code: 'report-manifest-invalid', detail: messageOf(error) }); return undefined; }
  const runId = dashboardText(manifest?.runId, 80);
  if (!manifest || manifest.format !== 'p2o-report' || !runId || !validId(runId)) {
    warnings.push({ code: 'report-manifest-invalid', detail: 'report-manifest.json is not a p2o-report bundle with a valid run id' });
    return undefined;
  }
  const listed = (Array.isArray(manifest.files) ? manifest.files : []).slice(0, 200).flatMap(item => {
    const row = record(item);
    return row && typeof row.name === 'string' && typeof row.bytes === 'number' && typeof row.sha256 === 'string'
      ? [{ name: row.name, bytes: row.bytes, sha256: row.sha256 }] : [];
  });
  const outcome = record(manifest.outcome);
  const summary: DashboardRunSummary = {
    runId, source: 'report', retention: 'unknown', target: null, targetKind: null, mode: null,
    startedAt: null, lastRecordAt: null, sequence: null, asOfSequence: Number.isSafeInteger(manifest.asOfSequence) ? Number(manifest.asOfSequence) : null,
    schemaVersion: null, graphVersion: 0, complete: typeof manifest.complete === 'boolean' ? manifest.complete : null,
    endReason: dashboardText(manifest.endReason, 80) ?? null, outcome: dashboardText(outcome?.assessmentOutcome, 40) ?? null,
    live: false, records: integer(manifest.records, 0),
    counts: { nodes: 0, edges: 0, anchors: 0, cases: 0, findingsAccepted: 0 }, warnings: [],
  };
  const entry = listed.find(item => item.name === 'findings.json');
  if (!entry) {
    warnings.push({ code: 'report-no-findings', runId, file: 'findings.json', detail: 'this bundle has no findings.json (report format 1); only its manifest is shown' });
    return { runId, summary, findings: [] };
  }
  let bytes: Buffer;
  try { bytes = await readFile(join(directory, 'findings.json')); }
  catch (error) { warnings.push({ code: 'report-file-unreadable', runId, file: 'findings.json', detail: messageOf(error) }); return { runId, summary, findings: [] }; }
  if (bytes.length !== entry.bytes) { warnings.push({ code: 'report-file-size', runId, file: 'findings.json', detail: `findings.json is ${bytes.length} bytes but the manifest lists ${entry.bytes}; the file was skipped` }); return { runId, summary, findings: [] }; }
  if (sha256Hex(bytes) !== entry.sha256) { warnings.push({ code: 'report-file-hash', runId, file: 'findings.json', detail: 'findings.json no longer matches the sha256 its manifest recorded; the file was skipped' }); return { runId, summary, findings: [] }; }
  let body: unknown;
  try { body = JSON.parse(bytes.toString('utf8')); }
  catch { warnings.push({ code: 'report-findings-invalid', runId, file: 'findings.json', detail: 'findings.json does not parse; the file was skipped' }); return { runId, summary, findings: [] }; }
  const findings = parseFindings(body, runId, warnings, 'report');
  summary.counts.findingsAccepted = findings.length;
  return { runId, summary, findings };
}

/** Bundle directories: the given root itself (an operator-named `--out` export) or one level of `report-<runId>` children. */
async function reportDirectories(root: string): Promise<string[]> {
  const manifestAt = (directory: string) => stat(join(directory, 'report-manifest.json')).then(info => info.isFile()).catch(() => false);
  if (await manifestAt(root)) return [root];
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort(byName);
  const found: string[] = [];
  for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && await manifestAt(join(root, entry.name))) found.push(join(root, entry.name));
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// Cross-run findings aggregation (§6.2 G3 rules): identity first, then one occurrence per (run, source), then conflicts.
// ---------------------------------------------------------------------------------------------------------------------
interface OccurrenceInput { run: DashboardRunSummary; source: 'store' | 'report'; row: DashboardFindingRow }

const identityOf = (input: OccurrenceInput): { id: string; identity: 'findingId' | 'fallback' } => {
  if (input.row.findingId) return { id: input.row.findingId, identity: 'findingId' };
  const target = dashboardText(input.run.target, 200)?.toLowerCase().trim() ?? '';
  const key = JSON.stringify([target, input.row.policyKey.toLowerCase().trim(), (input.row.rootCauseKey ?? '').toLowerCase().trim(), input.row.title.toLowerCase().trim()]);
  return { id: `fallback-${sha256Hex(key).slice(0, 32)}`, identity: 'fallback' };
};

function dedupe(inputs: readonly OccurrenceInput[]): { kept: OccurrenceInput[]; warnings: DashboardWarning[] } {
  const warnings: DashboardWarning[] = [];
  const sorted = [...inputs].sort((left, right) => left.run.runId.localeCompare(right.run.runId)
    || (left.source === right.source ? 0 : left.source === 'store' ? -1 : 1) || left.row.caseId.localeCompare(right.row.caseId) || left.row.caseRevision - right.row.caseRevision);
  const perSource = new Map<string, OccurrenceInput>();
  for (const entry of sorted) {
    const key = `${entry.run.runId}\u0000${entry.source}`;
    if (!perSource.has(key)) perSource.set(key, entry);
  }
  const kept = [...perSource.values()];
  // A store and its own report bundle are the same run: keep the report row only when it is demonstrably newer than the store.
  for (const [runId, storeRow] of kept.filter(entry => entry.source === 'store').map(entry => [entry.run.runId, entry] as const)) {
    const reportIndex = kept.findIndex(entry => entry.source === 'report' && entry.run.runId === runId);
    if (reportIndex < 0) continue;
    const reportRow = kept[reportIndex]!;
    const storeSequence = storeRow.run.sequence, reportSequence = reportRow.run.asOfSequence;
    if (storeSequence !== null && reportSequence !== null && storeSequence >= reportSequence) kept.splice(reportIndex, 1);
    else {
      const diverged = storeRow.row.severity !== reportRow.row.severity || storeRow.row.title !== reportRow.row.title;
      if (diverged) warnings.push({ code: 'store-report-divergence', runId, detail: 'the report bundle is newer than the store and lists a different severity/title; both rows are shown' });
    }
  }
  return { kept, warnings };
}

function occurrenceOf(input: OccurrenceInput): DashboardOccurrence {
  const { row, run } = input;
  return {
    runId: run.runId, source: input.source, retention: run.retention, asOfSequence: run.asOfSequence, complete: run.complete,
    findingId: row.findingId, identity: row.identity, caseId: row.caseId, caseRevision: row.caseRevision, title: row.title,
    severity: row.severity, verdict: row.verdict, reviewStatus: row.reviewStatus, currentness: row.currentness, accepted: row.accepted,
    policyKey: row.policyKey, rootCauseKey: row.rootCauseKey, remediationStatus: row.remediationStatus, retest: row.retest,
    cvss: row.cvss, cwe: row.cwe, wstg: row.wstg.map(item => item.key), techniques: row.techniques, assets: row.assets, time: row.time,
  };
}

function conflictsOf(occurrences: readonly DashboardOccurrence[]): DashboardConflict[] {
  const fields = ['severity', 'title', 'policyKey', 'rootCauseKey'] as const;
  return fields.flatMap(field => {
    const values = occurrences.map(entry => ({ runId: entry.runId, source: entry.source, value: entry[field] }));
    return new Set(values.map(entry => entry.value)).size > 1 ? [{ field, values }] : [];
  });
}

function aggregateFindings(inputs: readonly OccurrenceInput[], limits: DashboardLimits): { aggregates: DashboardFindingAggregate[]; totals: DashboardTotals; omitted: number; warnings: DashboardWarning[] } {
  const warnings: DashboardWarning[] = [], groups = new Map<string, OccurrenceInput[]>();
  for (const input of inputs) { const { id } = identityOf(input); groups.set(id, [...(groups.get(id) ?? []), input]); }
  const aggregates: DashboardFindingAggregate[] = [];
  for (const [id, group] of groups) {
    const { kept, warnings: dedupeWarnings } = dedupe(group);
    warnings.push(...dedupeWarnings);
    const occurrences = kept.map(occurrenceOf)
      .sort((left, right) => left.runId.localeCompare(right.runId) || (left.source === right.source ? 0 : left.source === 'store' ? -1 : 1) || left.caseId.localeCompare(right.caseId));
    const worst = dashboardWorstSeverity(occurrences.map(entry => entry.severity));
    const times = occurrences.flatMap(entry => entry.time ? [entry.time] : []).sort();
    const first = [...occurrences].sort((left, right) => dashboardSeverityRank(left.severity) - dashboardSeverityRank(right.severity)
      || left.runId.localeCompare(right.runId) || left.caseId.localeCompare(right.caseId))[0]!;
    aggregates.push({ id, identity: kept[0]!.row.identity, title: first.title, severity: worst,
      runs: [...new Set(occurrences.map(entry => entry.runId))].sort(),
      occurrences, conflicts: conflictsOf(occurrences),
      accepted: occurrences.filter(entry => entry.accepted).length, firstSeen: times[0] ?? null, lastSeen: times.at(-1) ?? null });
  }
  aggregates.sort((left, right) => dashboardSeverityRank(left.severity) - dashboardSeverityRank(right.severity)
    || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  const bySeverity: Record<string, number> = Object.fromEntries([...FINDING_SEVERITIES, 'not rated'].map(severity => [severity, 0]));
  for (const aggregate of aggregates) bySeverity[aggregate.severity] = (bySeverity[aggregate.severity] ?? 0) + 1;
  const totals: DashboardTotals = { runs: new Set(aggregates.flatMap(aggregate => aggregate.runs)).size, findings: aggregates.length,
    accepted: aggregates.reduce((sum, aggregate) => sum + aggregate.accepted, 0), bySeverity };
  return { aggregates: aggregates.slice(0, limits.findings), totals, omitted: Math.max(0, aggregates.length - limits.findings), warnings };
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-run data-tree bound: drop stated detail in a fixed order until the serialized run file fits, keeping counts honest.
// ---------------------------------------------------------------------------------------------------------------------
function fitRunFile(file: DashboardRunFile, limits: DashboardLimits, warnings: DashboardWarning[]): DashboardRunFile {
  const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
  if (bytes(file) <= limits.dataBytesPerRun) return file;
  const dropped: string[] = [];
  let current = file;
  const stripDetail = (reason: string): void => {
    dropped.push(reason);
    current = { ...current,
      graph: { ...current.graph, nodes: current.graph.nodes.map(node => node.body === undefined ? node : { ...node, body: undefined, bodyOmitted: true }) },
      cases: current.cases.map(row => row.reproduction.length ? { ...row, reproduction: [], reproductionOmitted: (row.reproductionOmitted ?? 0) + row.reproduction.length } : row),
      findings: current.findings.map(row => row.reproduction.length ? { ...row, reproduction: [], reproductionOmitted: (row.reproductionOmitted ?? 0) + row.reproduction.length } : row),
      omitted: { ...current.omitted, bodies: true, reproduction: true } };
  };
  stripDetail('node bodies and reproduction detail');
  if (bytes(current) <= limits.dataBytesPerRun) { warnings.push({ code: 'run-data-trimmed', runId: file.runId, detail: `dropped ${dropped.join(', ')} to fit the per-run data bound` }); return current; }
  dropped.push('case rows');
  current = { ...current, omitted: { ...current.omitted, cases: current.omitted.cases + current.cases.length }, cases: [] };
  if (bytes(current) <= limits.dataBytesPerRun) { warnings.push({ code: 'run-data-trimmed', runId: file.runId, detail: `dropped ${dropped.join(', ')} to fit the per-run data bound` }); return current; }
  dropped.push('graph rows');
  current = { ...current, omitted: { ...current.omitted, nodes: current.graph.nodes.length, edges: current.graph.edges.length, anchors: current.graph.anchors.length },
    graph: { ...emptyGraph(file.runId, current.graph.asOfSequence), graphVersion: current.graph.graphVersion, truncated: true } };
  if (bytes(current) <= limits.dataBytesPerRun) { warnings.push({ code: 'run-data-trimmed', runId: file.runId, detail: `dropped ${dropped.join(', ')} to fit the per-run data bound` }); return current; }
  dropped.push('finding rows');
  current = { ...current, omitted: { ...current.omitted, findings: current.omitted.findings + current.findings.length }, findings: [] };
  warnings.push({ code: 'run-data-trimmed', runId: file.runId, detail: `dropped ${dropped.join(', ')} to fit the per-run data bound; the run summary and counts still describe the derivation` });
  return current;
}

const omittedOf = (loaded: LoadedStore): DashboardRunOmitted =>
  ({ cases: Math.max(0, loaded.casesTotal - loaded.cases.length), findings: 0, nodes: 0, edges: 0, anchors: 0, bodies: false, reproduction: false });

/** Scan one root for run directories; symlinks are refused and non-directories are ignored, as the store itself requires. */
async function storeDirectories(root: string, warnings: DashboardWarning[]): Promise<Array<{ runId: string; root: string }>> {
  const found: Array<{ runId: string; root: string }> = [];
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort(byName);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) { warnings.push({ code: 'symlink-refused', detail: 'state directory is a symlink; refused', ...(validId(entry.name) ? { runId: entry.name } : {}) }); continue; }
    if (!entry.isDirectory() || !validId(entry.name)) continue;
    const file = await stat(join(root, entry.name, 'assessment.sqlite')).catch(() => undefined);
    if (file?.isFile()) found.push({ runId: entry.name, root });
  }
  return found;
}

export async function buildDashboard(input: DashboardBuildInput = {}): Promise<DashboardBuild> {
  const limits: DashboardLimits = { ...DASHBOARD_LIMITS, ...input.limits }, warnings: DashboardWarning[] = [];
  const wanted = input.runs?.length ? new Set(input.runs) : undefined, collectArtifacts = input.artifacts === true;

  const discovery: Array<{ runId: string; root: string }> = [];
  for (const root of input.stateRoots ?? []) {
    const directory = absolutize(root.path);
    if (!directory) { warnings.push({ code: 'root-invalid', detail: 'state root must be a normalized absolute path' }); continue; }
    try { discovery.push(...await storeDirectories(directory, warnings)); }
    catch (error) { if (!root.optional) warnings.push({ code: 'root-unreadable', detail: messageOf(error) }); }
  }
  discovery.sort((left, right) => left.runId.localeCompare(right.runId) || left.root.localeCompare(right.root));
  const uniqueStores: Array<{ runId: string; root: string }> = [];
  for (const entry of discovery) {
    if (uniqueStores.some(existing => existing.runId === entry.runId)) { warnings.push({ code: 'duplicate-run', runId: entry.runId, detail: 'the same run id exists in more than one state root; the first root won' }); continue; }
    uniqueStores.push(entry);
  }
  if (wanted) for (const runId of [...wanted].sort()) if (!uniqueStores.some(entry => entry.runId === runId)) warnings.push({ code: 'run-not-found', runId, detail: 'the requested run is not present in the scanned state roots' });
  const selectedStores = wanted ? uniqueStores.filter(entry => wanted.has(entry.runId)) : uniqueStores;
  const loadedStores: LoadedStore[] = [];
  for (const entry of selectedStores.slice(0, limits.runs)) {
    const loaded = await loadStore(entry.root, entry.runId, limits, warnings, collectArtifacts);
    if (loaded) loadedStores.push(loaded);
  }
  if (selectedStores.length > limits.runs) warnings.push({ code: 'runs-truncated', detail: `the state scan stopped at ${limits.runs} run(s); ${selectedStores.length - limits.runs} omitted` });

  const loadedReports: LoadedReport[] = [];
  const reportSeen = new Set<string>();
  for (const root of input.reportRoots ?? []) {
    const directory = absolutize(root.path);
    if (!directory) { warnings.push({ code: 'root-invalid', detail: 'report root must be a normalized absolute path' }); continue; }
    let bundles: string[] = [];
    try { bundles = await reportDirectories(directory); }
    catch (error) { if (!root.optional) warnings.push({ code: 'root-unreadable', detail: messageOf(error) }); continue; }
    for (const bundle of bundles.slice(0, limits.runs)) {
      const loaded = await loadReport(bundle, warnings);
      if (!loaded) continue;
      if (reportSeen.has(loaded.runId)) { warnings.push({ code: 'duplicate-report', runId: loaded.runId, detail: 'the same run id has more than one report bundle; the first bundle won' }); continue; }
      reportSeen.add(loaded.runId);
      loadedReports.push(loaded);
    }
    if (bundles.length > limits.runs) warnings.push({ code: 'reports-truncated', detail: `the report scan stopped at ${limits.runs} bundle(s); ${bundles.length - limits.runs} omitted` });
  }

  // Merge store and report views of the same run; the store is the fuller source, the bundle the fallback.
  const slots = new Map<string, { store?: LoadedStore; report?: LoadedReport }>();
  for (const loaded of loadedStores) slots.set(loaded.runId, { store: loaded });
  for (const loaded of loadedReports) slots.set(loaded.runId, { ...(slots.get(loaded.runId) ?? {}), report: loaded });
  const merged = [...slots.entries()].filter(([runId]) => !wanted || wanted.has(runId)).sort(([left], [right]) => left.localeCompare(right));

  const summaries: DashboardRunSummary[] = [], runFiles: DashboardRunFile[] = [], occurrences: OccurrenceInput[] = [], artifacts: DashboardArtifactBody[] = [];
  for (const [runId, slot] of merged) {
    const base = slot.store?.summary ?? slot.report!.summary;
    const source: DashboardSource = slot.store && slot.report ? 'both' : slot.store ? 'store' : 'report';
    const findings = slot.store ? slot.store.findings : slot.report!.findings;
    const summary: DashboardRunSummary = { ...base, source,
      counts: { nodes: slot.store?.graph.counts.nodes ?? 0, edges: slot.store?.graph.counts.edges ?? 0, anchors: slot.store?.graph.counts.anchors ?? 0,
        cases: slot.store?.casesTotal ?? 0, findingsAccepted: findings.length } };
    if (slot.store && slot.report) {
      const reportSequence = slot.report.summary.asOfSequence;
      if (reportSequence !== null && reportSequence > (slot.store.summary.sequence ?? -1))
        warnings.push({ code: 'report-newer-than-store', runId, detail: 'the report bundle records a later barrier than its store; the store rows are shown and the bundle rows are kept as occurrences' });
    }
    summaries.push(summary);
    const file: DashboardRunFile = { format: DASHBOARD_RUN_FORMAT, version: DASHBOARD_FORMAT_VERSION, runId, run: summary,
      graph: slot.store?.graph ?? emptyGraph(runId, summary.asOfSequence ?? 0), cases: slot.store?.cases ?? [], findings,
      artifacts: (slot.store?.artifacts ?? []).map(body => body.ref),
      omitted: slot.store ? omittedOf(slot.store) : { cases: 0, findings: 0, nodes: 0, edges: 0, anchors: 0, bodies: false, reproduction: false } };
    runFiles.push(fitRunFile(file, limits, warnings));
    if (slot.store) artifacts.push(...slot.store.artifacts);
    if (slot.store) for (const row of slot.store.findings) occurrences.push({ run: summary, source: 'store', row });
    if (slot.report) for (const row of slot.report.findings) occurrences.push({ run: summary, source: 'report', row });
  }

  const aggregated = aggregateFindings(occurrences, limits);
  warnings.push(...aggregated.warnings);
  const times = loadedStores.flatMap(loaded => loaded.summary.lastRecordAt ? [loaded.summary.lastRecordAt] : []).sort();
  const orderedWarnings = [...warnings].sort((left, right) => left.code.localeCompare(right.code) || (left.runId ?? '').localeCompare(right.runId ?? '') || left.detail.localeCompare(right.detail));
  for (const summary of summaries) summary.warnings = orderedWarnings.filter(item => item.runId === summary.runId).slice(0, 12).map(item => `${item.code}: ${item.detail}`);
  const index: DashboardIndexFile = {
    format: DASHBOARD_FORMAT, version: DASHBOARD_FORMAT_VERSION, generatedAt: times.at(-1) ?? null, labels: DASHBOARD_LABELS,
    runs: summaries.sort((left, right) => left.runId.localeCompare(right.runId)), findings: aggregated.aggregates, totals: aggregated.totals,
    limits, omitted: { findings: aggregated.omitted }, warnings: orderedWarnings,
  };
  return { index, runs: runFiles.sort((left, right) => left.runId.localeCompare(right.runId)), artifacts };
}

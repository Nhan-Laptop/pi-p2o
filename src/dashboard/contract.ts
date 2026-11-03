/**
 * planning_update.md P1 (path "a"): the JSON data contract the read-only dashboard consumes. Pure types and constants — no
 * I/O, no clock, no store access — so the read model, the snapshot writer, the server (P2/P3) and the tests describe one tree.
 *
 * Every value here is a projection of committed records: a dashboard row can be wrong because a record is old or missing, but
 * it never becomes a second authority. The client labels the difference; it does not repair it.
 */
import { FINDING_SEVERITIES } from '../case-types.js';
import type { FindingReproductionRow } from '../report-export.js';
import { EXPLORATION_PROJECTION_LABEL } from '../exploration-graph.js';
import { safeText } from '../evidence.js';

export const DASHBOARD_FORMAT = 'p2o-dashboard';
export const DASHBOARD_RUN_FORMAT = 'p2o-dashboard-run';
export const DASHBOARD_FORMAT_VERSION = 1;
/** A node body is display context, not an evidence dump: above this serialized cap it is omitted with `bodyOmitted: true`. */
export const DASHBOARD_NODE_BODY_BYTES = 600;

export interface DashboardLimits {
  /** Runs read from every state root together. */
  runs: number;
  /** All-case rows kept per retained store (the report's own CASE_ROWS bound). */
  casesPerRun: number;
  /** Aggregate findings kept in `index.json`; the rest is counted in `omitted.findings`. */
  findings: number;
  /** Serialized `runs/<runId>.json` cap; detail is dropped in a stated order until it fits. */
  dataBytesPerRun: number;
  /** Frozen data-tree cap written by `snapshot` (artifact copies land in P3 and count against it). */
  snapshotBytes: number;
  artifactsPerRun: number;
  artifactBytes: number;
}
export const DASHBOARD_LIMITS: DashboardLimits = {
  runs: 200, casesPerRun: 500, findings: 2000,
  dataBytesPerRun: 8 * 1024 * 1024, snapshotBytes: 64 * 1024 * 1024, artifactsPerRun: 64, artifactBytes: 1024 * 1024,
};

export const DASHBOARD_LABELS = {
  projection: EXPLORATION_PROJECTION_LABEL,
  authority: 'read-only dashboard over committed records; it holds no execution authority and cannot pause, stop or dispatch',
  redaction: 'values were redacted at commit and bounded here; a snapshot can still contain target data — review before sharing',
  scope: 'store runs list every case; report-only runs list accepted-current findings only; a missing row is not a clean result',
} as const;

/** Lower is worse; `not rated` sorts last. The order matches the report's severity vocabulary. */
export const dashboardSeverityRank = (value: string | null | undefined): number => {
  const index = value === null || value === undefined ? -1 : (FINDING_SEVERITIES as readonly string[]).indexOf(value);
  return index < 0 ? FINDING_SEVERITIES.length : index;
};
export const dashboardWorstSeverity = (values: readonly (string | null)[]): string => {
  let worst: string | null = null;
  for (const value of values) if (worst === null || dashboardSeverityRank(value) < dashboardSeverityRank(worst)) worst = value;
  return worst ?? 'not rated';
};

/** One bounded, control-free line of display text: committed values were redacted already, this bounds them for the payload. */
export const dashboardText = (value: unknown, max = 200): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const text = safeText(String(value)).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};
/** A node body is kept whole or omitted; a half-serialized object would be a lie the client cannot parse. */
export const dashboardNodeBody = (body: Record<string, unknown>): { body?: Record<string, unknown>; bodyOmitted?: true } =>
  Buffer.byteLength(JSON.stringify(body)) <= DASHBOARD_NODE_BODY_BYTES ? { body } : { bodyOmitted: true };

export type DashboardSource = 'store' | 'report' | 'both';
export type DashboardRetention = 'durable-local' | 'ephemeral' | 'unknown';
export type DashboardIdentity = 'findingId' | 'fallback';

/** `index.json` warnings: a bounded reason, never a filesystem path (a snapshot may be shared off this machine). */
export interface DashboardWarning { code: string; detail: string; runId?: string; file?: string }

export interface DashboardNode {
  id: string; kind: string; state: string; entityId: string; text: string;
  recordId?: string; inherited?: string; body?: Record<string, unknown>; bodyOmitted?: true;
}
export interface DashboardEdge { srcId: string; rel: string; dstId: string; inherited?: string }
export interface DashboardAnchor { nodeId: string; assetEntity: string; inherited?: string }
export interface DashboardGraph {
  label: string; runId: string; asOfSequence: number; graphVersion: number;
  nodes: DashboardNode[]; edges: DashboardEdge[]; anchors: DashboardAnchor[];
  counts: { nodes: number; edges: number; anchors: number };
  unresolved: number; overflow: number; chainOrderTruncated: number;
  /** Set when the data-tree cap forced the row arrays out; `counts` still reports what the derivation held. */
  truncated: boolean;
}

export interface DashboardRunSummary {
  runId: string; source: DashboardSource; retention: DashboardRetention;
  target: string | null; targetKind: string | null; mode: string | null;
  /** First and last committed record times; never a wall clock. Null for a report bundle, which records no time. */
  startedAt: string | null; lastRecordAt: string | null;
  /** `sequence` is the store's event head; `asOfSequence` is the report bundle's barrier. */
  sequence: number | null; asOfSequence: number | null;
  schemaVersion: number | null; graphVersion: number | null;
  complete: boolean | null; endReason: string | null; outcome: string | null;
  /** True when the store recorded no outcome: the run is still open as far as committed state can say. */
  live: boolean;
  records: number;
  counts: { nodes: number; edges: number; anchors: number; cases: number; findingsAccepted: number };
  warnings: string[];
}

/** One accepted-current finding as the report's `findings.json` projects it, reduced to what a dashboard row renders. */
export interface DashboardFindingRow {
  findingId: string | null; identity: DashboardIdentity;
  caseId: string; caseRevision: number; title: string;
  severity: string | null; verdict: string; reviewStatus: string; currentness: string; accepted: boolean;
  policyKey: string; rootCauseKey: string | null; remediationStatus: string;
  retest: { verdict: string; current: boolean; reason?: string } | null;
  cvss: { vector: string; baseScore: number; severity: string } | null;
  cwe: string[]; wstg: string[]; techniques: string[]; assets: string[];
  reproduction: FindingReproductionRow[]; reproductionOmitted?: number;
}

/** Every case of a retained store, not only the accepted ones: the report's accepted-only rule stays in `findings`. */
export interface DashboardCaseRow {
  id: string; revision: number; title: string;
  verdict: string; reviewStatus: string; currentness: string; accepted: boolean;
  canonicalCaseId: string; duplicateOf?: string; staleReasons: string[]; independentCurrent: boolean; readyToRate: boolean;
  severity: string | null; likelihood?: string; impact?: string;
  cvss: { vector: string; baseScore: number; severity: string } | null; cwe: string[];
  policyKey: string; rootCauseKey?: string;
  claimRefs: string[]; assetRefs: Array<{ id: string; revision?: number }>; taskRefs: Array<{ taskId: string; revision?: number }>;
  remediation: { status: string; reason: string };
  retest: { verdict: string; current: boolean } | null;
  ratedRevision?: number; ratingCurrent?: boolean;
  recordId: string; time: string | null;
  reproduction: FindingReproductionRow[]; reproductionOmitted?: number;
}

/** P3 fills these when the snapshot carries copied artifact bodies; P1 always writes an empty list. */
export interface DashboardArtifactRef { artifactId: string; bytes: number; sha256: string; truncated: boolean; file: string }

export interface DashboardRunOmitted { cases: number; findings: number; nodes: number; edges: number; anchors: number; bodies: boolean; reproduction: boolean }

export interface DashboardRunFile {
  format: typeof DASHBOARD_RUN_FORMAT; version: number; runId: string;
  run: DashboardRunSummary; graph: DashboardGraph;
  cases: DashboardCaseRow[]; findings: DashboardFindingRow[]; artifacts: DashboardArtifactRef[];
  omitted: DashboardRunOmitted;
}

export interface DashboardConflict { field: 'severity' | 'title' | 'policyKey' | 'rootCauseKey'; values: Array<{ runId: string; source: 'store' | 'report'; value: string | null }> }
export interface DashboardOccurrence {
  runId: string; source: 'store' | 'report'; retention: DashboardRetention;
  asOfSequence: number | null; complete: boolean | null;
  findingId: string | null; identity: DashboardIdentity; caseId: string; caseRevision: number;
  title: string; severity: string | null; verdict: string; reviewStatus: string; currentness: string; accepted: boolean;
  policyKey: string; rootCauseKey: string | null; remediationStatus: string;
  retest: { verdict: string; current: boolean } | null;
  cvss: { vector: string; baseScore: number; severity: string } | null;
  cwe: string[]; wstg: string[]; techniques: string[]; assets: string[]; time: string | null;
}
export interface DashboardFindingAggregate {
  id: string; identity: DashboardIdentity; title: string; severity: string;
  runs: string[]; occurrences: DashboardOccurrence[]; conflicts: DashboardConflict[];
  accepted: number; firstSeen: string | null; lastSeen: string | null;
}

export interface DashboardTotals {
  runs: number; findings: number; accepted: number;
  bySeverity: Record<string, number>;
}

export interface DashboardIndexFile {
  format: typeof DASHBOARD_FORMAT; version: number;
  /** Latest committed record time across the scanned stores; null when only report bundles were read. Never a wall clock. */
  generatedAt: string | null;
  labels: typeof DASHBOARD_LABELS;
  runs: DashboardRunSummary[];
  findings: DashboardFindingAggregate[];
  totals: DashboardTotals;
  limits: DashboardLimits;
  omitted: { findings: number };
  warnings: DashboardWarning[];
}

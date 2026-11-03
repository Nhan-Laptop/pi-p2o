/**
 * planning_update.md P2/P3 (path "a"): the subset of the dashboard data contract (`src/dashboard/contract.ts`) that this client
 * reads. It is a structural mirror rather than an import: the client is a separate build with its own module graph, and the
 * extension must never depend on it.
 *
 * Drift is caught, not assumed away: `tests/minimal/dashboard-export.test.ts` assigns the host's real `index.json` and
 * `runs/<runId>.json` values to these types, so a field the host renames or drops fails the root typecheck.
 */

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
  truncated: boolean;
}

export interface DashboardRunSummary {
  runId: string; source: 'store' | 'report' | 'both'; retention: 'durable-local' | 'ephemeral' | 'unknown';
  target: string | null; targetKind: string | null; mode: string | null;
  startedAt: string | null; lastRecordAt: string | null;
  sequence: number | null; asOfSequence: number | null;
  schemaVersion: number | null; graphVersion: number | null;
  complete: boolean | null; endReason: string | null; outcome: string | null;
  live: boolean;
  busy?: boolean;
  incompatible?: boolean;
  records: number;
  counts: { nodes: number; edges: number; anchors: number; cases: number; findingsAccepted: number };
  /** P5a: true when the run file carries a REPORT.md body; the report tab states the absence instead of guessing. */
  hasReport?: boolean;
  warnings: string[];
}

export interface DashboardTotals { runs: number; findings: number; accepted: number; bySeverity: Record<string, number> }
export interface DashboardLabels { projection: string; authority: string; redaction: string; scope: string }

/** One bounded reproduction receipt as the report shares it; `captures` are retained artifact ids, not body text. */
export interface FindingReproductionRow {
  evidenceId: string; role?: string; note?: string; available: boolean;
  operation: string | null; by: string | null; exitCode: unknown;
  input: string | null; output: string | null; truncated: boolean;
  captures: Array<{ id: string; bytes: number; sha256: string; partial: boolean }>;
}

export interface DashboardFindingTraffic { role: string; position: number; snapshotRef: string }
export interface DashboardFindingWstg { key: string; page: string | null }
export interface DashboardFindingChainStep {
  order: number; step: string; claimRef: string | null;
  gained: string[]; needs: string[]; effect: string | null; reach: Record<string, unknown> | null;
}
export interface DashboardFindingChain {
  objective: string; demonstratedThrough: number | null;
  impact: { vector: string; score: number; severity: string; effect: string } | null;
  steps: DashboardFindingChainStep[];
}
export interface DashboardFindingRetest {
  verdict: string; caseRevision: number; current: boolean; reason: string;
  evidenceRefs: string[]; provenance: string | null; retesters: string[];
}
export interface DashboardFindingRemediation { status: string; reason: string; steps: string | null }
export interface DashboardFindingContradiction { evidenceRef: string; status: string }

/** One accepted-current finding at the report's evidence detail (the `findings.json` item, bounded by the host). */
export interface DashboardFindingRow {
  findingId: string | null; identity: 'findingId' | 'fallback';
  caseId: string; caseRevision: number; title: string;
  severity: string | null; verdict: string; reviewStatus: string; currentness: string; accepted: boolean;
  independentValidationCurrent: boolean; independenceReason: string | null;
  policyKey: string; rootCauseKey: string | null; remediationStatus: string; remediation: DashboardFindingRemediation;
  retest: DashboardFindingRetest | null;
  cvss: { vector: string; baseScore: number; severity: string } | null;
  cwe: string[]; wstg: DashboardFindingWstg[]; techniques: string[]; assets: string[];
  severityBasis: string | null; likelihood: string | null; impact: string | null;
  ratingLimitations: string | null; ratingProvenance: string | null; ratingFlags: string[];
  evidenceVersion: string | null; traffic: DashboardFindingTraffic[];
  claims: string[]; independentEvidence: string[]; references: string[];
  contradictions: DashboardFindingContradiction[];
  limitations: string | null; independenceWaiver: string | null;
  chain: DashboardFindingChain | null;
  time: string | null;
  reproduction: FindingReproductionRow[]; reproductionOmitted?: number;
}

/** Every case of a retained store, not only the accepted ones; the report's accepted-only rule stays in `findings`. */
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

/** Snapshot mode only: a copied, bounded, redacted artifact body and the metadata saying exactly what it is. */
export interface DashboardArtifactRef { artifactId: string; bytes: number; sha256: string; truncated: boolean; file: string }

export interface DashboardRunOmitted { cases: number; findings: number; nodes: number; edges: number; anchors: number; bodies: boolean; reproduction: boolean }

/** P5a: the deterministic report document kept as exact text ("a viewer, not a renderer"); the client never converts it to HTML. */
export interface DashboardRunReport {
  file: 'REPORT.md'; bytes: number; sha256: string;
  /** `bundle` is the exported report's own bytes; `store` is rendered from committed records with default settings. */
  origin: 'store' | 'bundle';
  /** False for a store-rendered body: a CLI export can differ in operator fields, pinned WSTG pages, runtime version and draft/final wording. */
  exportEquivalent: boolean;
  /** The barrier the body describes (the store's sequence or the bundle's asOfSequence); never a wall clock. */
  asOfSequence: number | null;
  text: string;
}

export interface DashboardRunFile {
  format: string; version: number; runId: string;
  run: DashboardRunSummary;
  graph: DashboardGraph;
  cases: DashboardCaseRow[];
  findings: DashboardFindingRow[];
  artifacts: DashboardArtifactRef[];
  /** P5a: present only when a bounded REPORT.md body was retained; absence is stated by a run warning, never by an empty file. */
  report?: DashboardRunReport;
  omitted: DashboardRunOmitted;
}

/** Host bounds mirrored for the client's own labels; the snapshot's `limits` value stays the authoritative copy. */
export interface DashboardLimits {
  runs: number; directoryEntries: number; casesPerRun: number; findings: number; dataBytesPerRun: number;
  snapshotBytes: number; artifactsPerRun: number; artifactBytes: number;
  /** Bounded REPORT.md body kept per run; a larger body is omitted as `report-too-large`, never clipped into a fake report. */
  reportBytes: number;
}
export const DASHBOARD_LIMITS: DashboardLimits = {
  runs: 200, directoryEntries: 2000, casesPerRun: 500, findings: 2000,
  dataBytesPerRun: 8 * 1024 * 1024, snapshotBytes: 64 * 1024 * 1024, artifactsPerRun: 64, artifactBytes: 1024 * 1024,
  reportBytes: 2 * 1024 * 1024,
};

export interface DashboardConflict { field: 'severity' | 'title' | 'policyKey' | 'rootCauseKey'; values: Array<{ runId: string; source: 'store' | 'report'; value: string | null }> }
export interface DashboardOccurrence {
  runId: string; source: 'store' | 'report'; retention: 'durable-local' | 'ephemeral' | 'unknown';
  asOfSequence: number | null; complete: boolean | null;
  findingId: string | null; identity: 'findingId' | 'fallback'; caseId: string; caseRevision: number;
  title: string; severity: string | null; verdict: string; reviewStatus: string; currentness: string; accepted: boolean;
  policyKey: string; rootCauseKey: string | null; remediationStatus: string;
  retest: { verdict: string; current: boolean } | null;
  cvss: { vector: string; baseScore: number; severity: string } | null;
  cwe: string[]; wstg: string[]; techniques: string[]; assets: string[]; time: string | null;
}
export interface DashboardFindingAggregate {
  id: string; identity: 'findingId' | 'fallback'; title: string; severity: string;
  runs: string[]; occurrences: DashboardOccurrence[]; conflicts: DashboardConflict[];
  accepted: number; firstSeen: string | null; lastSeen: string | null;
}

export interface DashboardIndexFile {
  format: string; version: number; generatedAt: string | null;
  labels: DashboardLabels;
  runs: DashboardRunSummary[];
  findings: DashboardFindingAggregate[];
  totals: DashboardTotals;
  limits: DashboardLimits;
  omitted: { findings: number };
  warnings: DashboardWarning[];
}

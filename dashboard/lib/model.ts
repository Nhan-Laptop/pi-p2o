/**
 * planning_update.md P2 (path "a"): the subset of the dashboard data contract (`src/dashboard/contract.ts`) that this client
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
  records: number;
  counts: { nodes: number; edges: number; anchors: number; cases: number; findingsAccepted: number };
  warnings: string[];
}

export interface DashboardTotals { runs: number; findings: number; accepted: number; bySeverity: Record<string, number> }
export interface DashboardLabels { projection: string; authority: string; redaction: string; scope: string }

export interface DashboardIndexFile {
  format: string; version: number; generatedAt: string | null;
  labels: DashboardLabels;
  runs: DashboardRunSummary[];
  totals: DashboardTotals;
  warnings: DashboardWarning[];
}

export interface DashboardRunFile {
  format: string; version: number; runId: string;
  run: DashboardRunSummary;
  graph: DashboardGraph;
}

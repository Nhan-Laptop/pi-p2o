/**
 * R1.1/W7: the asset dossier — one bounded read answering "what do we know, what is confirmed, and what is missing on this
 * asset?". It is a projection composed on read from the graph view and the ledger (claims, cases, coverage cells, tasks);
 * nothing here is stored, so it cannot become a second source of truth. The store stays graph-only and the ledger stays the
 * evidence ledger; this module only decides what a bounded dossier shows and when it says "omitted".
 */
import { isDemonstrated } from './claims.js';
import { safeText } from './evidence.js';

export interface DossierFact { entityId: string; kind: string; statement: string; confidence?: string; recordedBy?: string; evidenceRefs?: string[]; producerRole?: string }
export interface DossierHypothesis { entityId: string; statement: string; status: string; impact?: string; producerRole?: string; unverified?: boolean }
export interface DossierRelationRow { entityId: string; kind: string; direction: 'incoming' | 'outgoing'; otherId: string; basis?: string; unverified?: boolean; note?: string }
export interface DossierClaim { recordId: string; candidate: string; closure?: string; execution?: string; proof?: string; taskRef?: string; assetRevisions: number[]; stale: boolean }
export interface DossierCase { id: string; title: string; severity?: string; reviewStatus?: string; acceptedFinding: boolean; currentness: string }
export interface DossierCoverageCell { planId: string; questionKey: string; execution?: string; assessment?: string; currentness: string }
export interface DossierTaskRow { id: string; status: string; question?: string }
export interface DossierLimits { facts?: number; hypotheses?: number; relations?: number; claims?: number; cases?: number; cells?: number; tasks?: number }
export interface DossierInput {
  asset: { entityId: string; kind: string; key: string; label?: string; revision: number };
  counts: { revisions: number; assertions: number; relations: number; anchors: number };
  facts: DossierFact[]; hypotheses: DossierHypothesis[]; relations: DossierRelationRow[];
  claims: DossierClaim[]; cases: DossierCase[]; cells: DossierCoverageCell[]; tasks: DossierTaskRow[];
  limits?: DossierLimits;
}
export interface AssetDossier {
  asset: DossierInput['asset'];
  counts: DossierInput['counts'];
  /** Confirmed+tested current claims on this asset: what the graph can say is actually demonstrated. */
  demonstrated: string[];
  facts: DossierFact[];
  hypotheses: { open: number; supported: number; refuted: number; inconclusive: number; unreviewed: number; rows: DossierHypothesis[] };
  relations: DossierRelationRow[];
  claims: DossierClaim[];
  cases: DossierCase[];
  coverage: { cells: DossierCoverageCell[]; noCell: boolean };
  tasks: DossierTaskRow[];
  gaps: { noClaim: boolean; noDemonstratedClaim: boolean; noCoverageCell: boolean; openHypotheses: number; inferredRelations: number };
  omitted: { facts: number; hypotheses: number; relations: number; claims: number; cases: number; cells: number; tasks: number };
  text: string[];
}

const DEFAULT: Required<DossierLimits> = { facts: 10, hypotheses: 5, relations: 20, claims: 10, cases: 10, cells: 10, tasks: 10 };
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);
const clean = (value: unknown, max = 300): string => typeof value === 'string' ? clip(safeText(value), max) : '';

/** R1.1: compose the bounded dossier. Ordering is deterministic (recorded order, then id) so two reads of one state agree. */
export function assetDossier(input: DossierInput): AssetDossier {
  const limit = { ...DEFAULT, ...(input.limits ?? {}) };
  const claims = [...input.claims].sort((a, b) => a.recordId.localeCompare(b.recordId));
  const cases = [...input.cases].sort((a, b) => a.id.localeCompare(b.id));
  const cells = [...input.cells].sort((a, b) => a.planId.localeCompare(b.planId) || a.questionKey.localeCompare(b.questionKey));
  const tasks = [...input.tasks].sort((a, b) => a.id.localeCompare(b.id));
  const facts = input.facts.map(row => ({ ...row, statement: clean(row.statement) }));
  const hypotheses = input.hypotheses.map(row => ({ ...row, statement: clean(row.statement), ...(row.impact ? { impact: clean(row.impact, 200) } : {}) }));
  const relations = input.relations.map(row => ({ ...row, ...(row.note ? { note: clean(row.note, 200) } : {}) }));
  const statusCount = (status: string) => hypotheses.filter(row => row.status === status).length;
  const inferredRelations = relations.filter(row => row.basis === 'inferred' || row.unverified).length;
  const demonstrated = claims.filter(claim => isDemonstrated({ closure: claim.closure, execution: claim.execution })).map(claim => claim.recordId);
  const shown = (rows: readonly unknown[], max: number) => Math.min(rows.length, max);
  const dossier: AssetDossier = {
    asset: { ...input.asset, label: input.asset.label === undefined ? undefined : clean(input.asset.label, 200), key: clean(input.asset.key, 200) },
    counts: input.counts,
    demonstrated,
    facts: facts.slice(0, limit.facts),
    hypotheses: { open: statusCount('open'), supported: statusCount('supported'), refuted: statusCount('refuted'), inconclusive: statusCount('inconclusive'),
      unreviewed: hypotheses.filter(row => row.unverified === true || (row.status === 'open' && row.producerRole !== undefined && row.producerRole !== 'owner')).length,
      rows: hypotheses.slice(0, limit.hypotheses) },
    relations: relations.slice(0, limit.relations),
    claims: claims.slice(0, limit.claims),
    cases: cases.slice(0, limit.cases),
    coverage: { cells: cells.slice(0, limit.cells), noCell: cells.length === 0 },
    tasks: tasks.slice(0, limit.tasks),
    gaps: { noClaim: claims.length === 0, noDemonstratedClaim: demonstrated.length === 0, noCoverageCell: cells.length === 0, openHypotheses: statusCount('open'), inferredRelations },
    omitted: { facts: facts.length - shown(facts, limit.facts), hypotheses: hypotheses.length - shown(hypotheses, limit.hypotheses), relations: relations.length - shown(relations, limit.relations),
      claims: claims.length - shown(claims, limit.claims), cases: cases.length - shown(cases, limit.cases), cells: cells.length - shown(cells, limit.cells), tasks: tasks.length - shown(tasks, limit.tasks) },
    text: [],
  };
  const text = [`${dossier.asset.kind} ${dossier.asset.key}${dossier.asset.label ? ` "${dossier.asset.label}"` : ''} (${dossier.asset.entityId}@r${dossier.asset.revision}): revisions ${input.counts.revisions}, assertions ${input.counts.assertions}, relations ${input.counts.relations}, anchors ${input.counts.anchors}`,
    `knowledge: ${facts.length} fact(s), ${statusCount('open')} open / ${statusCount('supported')} supported / ${statusCount('refuted')} refuted / ${statusCount('inconclusive')} inconclusive hypothesis(es), ${relations.length} relation(s) (${inferredRelations} inferred/unverified)`,
    `ledger: ${claims.length} claim(s) (${demonstrated.length} demonstrated), ${cases.length} case(s) (${cases.filter(row => row.acceptedFinding).length} accepted finding(s)), ${cells.length} coverage cell(s), ${tasks.length} task(s)`,
    ...(dossier.gaps.noClaim ? ['gap: no claim is attached to this asset yet'] : []),
    ...(dossier.gaps.noDemonstratedClaim ? ['gap: no confirmed+tested claim stands on this asset'] : []),
    ...(dossier.gaps.noCoverageCell ? ['gap: no coverage cell names this asset'] : []),
    ...(dossier.gaps.openHypotheses ? [`review: ${dossier.gaps.openHypotheses} open hypothesis(es) await owner settlement`] : [])];
  dossier.text = text;
  return dossier;
}

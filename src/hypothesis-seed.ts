import { sha256Hex } from './validate.js';
import type { TaskDraft } from './tasks.js';

/**
 * planning_update.md W-Z option C (C2): an owner-triaged scanner hypothesis seeds exactly ONE investigation intent. A scanner
 * match is a lead, never a claim: the seed asks a worker to reproduce it with its own in-band oracle (baseline+probe, negative
 * control), and only that worker's own candidate can carry the result further. This module is pure — it reads plain data the
 * caller extracted from the retained hypothesis row and its asset head, writes nothing, creates no candidate/claim, and never
 * touches the row. The task id is derived from the run and the retained row revision id, so re-triaging the same row is
 * deterministic: the board refuses the duplicate instead of seeding a second intent. The caller gates with
 * isSeedableHypothesis() so a settled or foreign row never seeds.
 */

export function hypothesisSeedKey(runId: string, rowId: string): string {
  return `seed-${sha256Hex(JSON.stringify([runId, rowId])).slice(0, 40)}`;
}

/** Plain data the caller extracts from the retained assertion row (table 'assertions', kind 'hypothesis') and its asset head. */
export interface HypothesisSeedSource {
  rowId: string; entityId: string; statement: string; impact?: string; severity?: string;
  assetId: string; assetKey?: string; assetRevision: number; evidenceRefs: string[];
}

/** W-Z/C2: risk is cosmetic triage wording; an explicit value wins, severity only picks the default band. */
export interface HypothesisSeedOptions { runId: string; risk?: 'low' | 'medium' | 'high' | 'critical' }

const bounded = (value: string, max: number): string => value.length > max ? value.slice(0, max) : value;
/** Scanner severity is free text from a template; critical/high are the bands that deserve a medium triage risk, the rest low. */
const elevated = (severity: string | undefined): boolean => ['critical', 'high'].includes(String(severity ?? '').trim().toLowerCase());

/**
 * The one task-shaped draft an owner-triaged scanner hypothesis seeds. Fields are the task admission vocabulary, not free prose:
 * role 'general' + purpose 'investigation' is the purpose that may stand on a pinned asset revision (a raw hypothesis cannot seed
 * role=validation, which needs a reviewed predecessor), there is no validationOf/retestOf/prerequisites and no claimRefs, so the
 * seed can never claim the hypothesis or fan out into a case.
 */
export function hypothesisSeedDraft(source: HypothesisSeedSource, options: HypothesisSeedOptions): TaskDraft {
  const asset = source.assetKey ?? `graph ${source.assetId}`;
  const excerpt = bounded(source.statement.trim(), 600);
  return {
    id: hypothesisSeedKey(options.runId, source.rowId),
    question: bounded(`Scanner hypothesis ${source.entityId} on ${asset} needs its own in-band oracle before it can be a claim: reproduce the reported match ("${excerpt}"), then record ONE candidate with your own receipts (baseline+probe, negative control). A scanner match is not evidence.`, 1500),
    surface: bounded(asset, 200),
    risk: options.risk ?? (elevated(source.severity) ? 'medium' : 'low'),
    role: 'general',
    roleReason: 'Owner-triaged scanner hypothesis: an unverified match needs its own oracle before it can be a claim',
    expectedTrue: bounded(`The scanner hypothesis ${source.entityId} reproduces on ${asset} and the in-band oracle separates it from a false match: the baseline and probe receipts show the reported behaviour and the negative control does not. Record the candidate with its own receipt ids.`, 1000),
    expectedFalse: bounded(`The scanner hypothesis ${source.entityId} does not reproduce on ${asset}, or the in-band oracle stays inconclusive: record the negative result with the receipts and do not promote the hypothesis to a claim.`, 1000),
    stopCondition: 'Stop after one reproduction attempt with/without the oracle, or a concrete prerequisite gap; no retry loop.',
    // Same-run receipt ids the row already cites; the admission check refuses an id that is not a same-run evidence record.
    evidenceIds: [...new Set(source.evidenceRefs)].slice(0, 4),
    prerequisites: [],
    method: { skills: [], reason: 'Host-seeded investigation from an owner-triaged scanner hypothesis; dispatch resolves the method from role/purpose.' },
    work: { assetRefs: [{ id: source.assetId, revision: source.assetRevision }], questionKey: `hypothesis:${source.entityId}`, methodFamily: 'scanner-hypothesis-triage', purpose: 'investigation' },
  };
}

/**
 * Only a still-open hypothesis row of the assertion table may seed. A supported/refuted/inconclusive row was already settled by
 * an owner review (a supported review supersedes it), and a foreign table/kind is not a hypothesis at all.
 */
export function isSeedableHypothesis(row: { table?: string; kind?: string; status?: string }): boolean {
  return row.table === 'assertions' && row.kind === 'hypothesis' && row.status === 'open';
}

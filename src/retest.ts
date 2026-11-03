import type { LedgerIndex } from './records.js';
import type { MutationRequest } from './state/store.js';
import { exact, fieldValidators, plain } from './validate.js';

/**
 * R3.5: an owner retest is the one thing a finding needs after remediation — a fresh observation that the effect still reproduces,
 * no longer reproduces, or could not be confirmed. It is its own owner note (`data.caseRetest`), never a case revision: retesting
 * neither changes the verdict or review status nor stales the coverage cells that pin the case revision, exactly like `caseRating`.
 *
 * The stored record is one row per case revision. The verdict is an owner observation, not a proof level: `still_reproducible` and
 * `fixed` rest on same-run evidence the host checks, `cannot_confirm` is the honest answer when the environment moved and may cite
 * nothing. A retest never rates, never re-accepts and never satisfies a claim or coverage cell; the report prints it next to the
 * finding so a reader sees the finding's current state without treating it as a new finding.
 *
 * W-AA/B: the two evidentiary verdicts now need a receipt another worker recorded — the owner's own note is an observation, not a
 * second pair of eyes, and a claim author cannot confirm its own finding. Independence is HOST-DERIVED: the model names receipts,
 * the host reads who committed each one and whether any of them is outside the case's claim authors, and stores that provenance on
 * the note. A note recorded before this rule has no provenance fields; the report says so instead of implying a replay that was
 * never recorded.
 */
export const CASE_RETEST_VERDICTS = ['still_reproducible', 'fixed', 'cannot_confirm'] as const;
export type CaseRetestVerdict = typeof CASE_RETEST_VERDICTS[number];

/** Host-derived retest provenance: how far the cited receipts are from the worker(s) that authored the finding. */
export type RetestProvenanceKind = 'independent_replay' | 'owner_only' | 'unrecorded';
export interface RetestProvenance { kind: RetestProvenanceKind; retesters: string[]; label: string }

/** One retest observation: the case revision it was recorded against and the evidence it rests on (empty only for cannot_confirm). */
export interface CaseRetest {
  caseId: string;
  caseRevision: number;
  verdict: CaseRetestVerdict;
  reason: string;
  evidenceRefs: string[];
  recordId: string;
  /** Host-derived: true when at least one cited receipt was recorded by a worker outside the case's claim authors. */
  independentReplay?: boolean;
  /** Host-derived: worker ids whose receipts the verdict cites (empty when it cites none, e.g. cannot_confirm). */
  retesters?: string[];
}

/** Reader-facing provenance of one retest; a legacy note without the host fields is labelled unrecorded, never implied independent. */
export function retestProvenance(retest: CaseRetest): RetestProvenance {
  const retesters = retest.retesters ?? [];
  if (retest.independentReplay === true) return { kind: 'independent_replay', retesters, label: `independent replay by ${retesters.join(', ') || 'a worker outside the finding author(s)'}` };
  if (retest.independentReplay === false) return { kind: 'owner_only', retesters, label: 'owner note; no independent worker replay recorded' };
  return { kind: 'unrecorded', retesters: [], label: 'owner-attributed; provenance not recorded before the independence check' };
}

const { text, id, revision, ids } = fieldValidators('case retest');

/** Validate the model-supplied part of a retest. The case identity is host-bound from the verb's `id` and `revision`. */
export function validateRetest(value: unknown): { verdict: CaseRetestVerdict; reason: string; evidenceRefs: string[] } {
  const row = plain(value, 'case retest');
  exact(row, ['verdict', 'reason', 'evidenceRefs'], 'Case retest');
  if (typeof row.verdict !== 'string' || !(CASE_RETEST_VERDICTS as readonly string[]).includes(row.verdict)) throw Error(`Invalid case retest verdict: use ${CASE_RETEST_VERDICTS.join(', ')}`);
  return { verdict: row.verdict as CaseRetestVerdict, reason: text(row.reason, 'retest reason', 1000, 10), evidenceRefs: ids(row.evidenceRefs ?? [], 'retest evidence', 10) };
}

/** Idempotency binding of a retest request; the value is validated first so a replay compares the same canonical payload. */
export function boundRetestRequest(idValue: string, caseRevision: number, value: unknown, request: MutationRequest): MutationRequest {
  if (request.actorId !== 'owner') throw Error('Case retests require host-bound owner attribution');
  return { ...request, payload: { kind: 'case-retest', id: idValue, revision: caseRevision, retest: validateRetest(value), submitted: request.payload } };
}

/** Latest owner retest per case id, in ledger order. Malformed or foreign-run notes are not promoted, as for cases and ratings. */
export function caseRetests(index: LedgerIndex): Map<string, CaseRetest> {
  const latest = new Map<string, CaseRetest>();
  for (const row of index.records) {
    const value = row.kind === 'note' && row.by === 'owner' && !row.workerId ? row.data?.caseRetest as Record<string, unknown> | undefined : undefined;
    if (!row.id || !value || typeof value !== 'object') continue;
    try {
      const caseId = id(value.caseId, 'ID'), caseRevision = revision(value.caseRevision, 'revision'), verdict = value.verdict;
      if (typeof verdict !== 'string' || !(CASE_RETEST_VERDICTS as readonly string[]).includes(verdict)) continue;
      const independence = value.independentReplay === true ? true : value.independentReplay === false ? false : undefined;
      const retesters = Array.isArray(value.retesters) ? value.retesters.flatMap(item => typeof item === 'string' && item.length > 0 && item.length <= 120 ? [item] : []).slice(0, 6) : [];
      latest.set(caseId, { caseId, caseRevision, verdict: verdict as CaseRetestVerdict, reason: text(value.reason, 'reason', 1000, 10), evidenceRefs: ids(value.evidenceRefs ?? [], 'evidence', 10), recordId: row.id,
        ...(independence === undefined ? {} : { independentReplay: independence }), ...(retesters.length ? { retesters } : {}) });
    } catch { /* Untrusted/legacy notes are not promoted. */ }
  }
  return latest;
}

/** True when the retest was recorded against the case revision the board currently holds. */
export const retestCurrent = (retest: CaseRetest | undefined, caseRevision: number): boolean => retest !== undefined && retest.caseRevision === caseRevision;

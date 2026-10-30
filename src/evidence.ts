import { randomUUID, createHash } from 'node:crypto';
import { clampProseInPlace, PROSE_CAPS, sha256Hex } from './validate.js';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { appendRecord, LEDGER_ROW_BYTES, readLedger, type AssessmentRecord } from './records.js';
import { isConfirmedClaim, isDemonstrated, isOpenGap, isRuledOutClaim, isTestedClaim } from './claims.js';
import { capabilityKey, readCapabilities } from './capabilities.js';
import { campaignFromRecords } from './campaign.js';
import { policySourceLabel } from './policy-artifact.js';
import { cleanText, type ProcessResult } from './process.js';
import { redactArtifactPrefix, type CaptureReceipt } from './artifacts.js';
import { capabilityList, type Capability } from './capabilities.js';
import { EnvironmentStore, PayloadStore, environmentExists, isEnvironmentId, isPayloadId, payloadExists } from './lab.js';
import type { ReplayStamp } from './replay.js';

export const CANDIDATE_CLOSURES = ['confirmed', 'ruled_out', 'open_proof_gap'] as const;
export const CANDIDATE_EXECUTIONS = ['tested', 'not_tested', 'blocked', 'not_applicable'] as const;
export const CANDIDATE_PROOFS = ['static_trace', 'offline_reproduction', 'live_reproduction'] as const;
export const POLICY_BASES = ['explicit_contract', 'boundary_invariant', 'operator_contract', 'inferred'] as const;
export interface Candidate {
  candidate: string; surface: string; risk: string;
  closure: typeof CANDIDATE_CLOSURES[number];
  execution: typeof CANDIDATE_EXECUTIONS[number];
  proof: typeof CANDIDATE_PROOFS[number];
  evidenceRefs: string[]; negativeControls: string[]; limitations: string;
  policyBasis?: typeof POLICY_BASES[number]; expectedPolicy?: string;
  control?: string; requirement?: string; supersedes?: string; independentEvidenceRef?: string; resolves?: string[];
  /**
   * P21/A2: one-field validation write-back. The validation worker names the claim (record id or slug) its own receipts
   * reproduce; the host resolves it, checks actor, surface/risk and the recorded replay hash, and stamps the independent
   * receipt internally. It is an alternative to `independentEvidenceRef`, never a pair.
   */
  reproduces?: string;
  /**
   * P21/B1: the run policy artifact id a claim under `operator_contract` cites. The host records it only when the campaign
   * frame holds that artifact; it is provenance, never proof, and no basis makes a claim tested.
   */
  policyRef?: string;
  /** Capabilities this primitive hands to a later step, and the ones it needs from an earlier step or the environment (P14.1:
   *  typed, so a chain link is a match rather than a shared word). */
  gained?: Capability[]; needs?: Capability[];
  /** Free text caveat about the capability pair: displayed, never matched. */
  note?: string;
  /** Run-scoped payload artifact that actually ran (P14.2), so a second worker can replay these exact bytes. */
  payloadRef?: string;
  /** Run-scoped environment recipe the payload was demonstrated in (P14.3); `replayable` needs both. */
  environmentRef?: string;
  /** P16.4: CVE lead record ids this hypothesis cites. A lead is a pointer to test, never the demonstration itself. */
  leadRefs?: string[];
  /**
   * P14.12: what actually ran, stamped by the host when the claim is recorded — the payload's sha256 and the environment's recipe
   * fingerprint. Independence is then a comparison of these two values and not a comparison of two workers' sentences, and no caller can
   * assert them because the store overwrites whatever arrives.
   */
  payloadSha256?: string;
  environmentFingerprint?: string;
}
/**
 * R1.2/D-R1-1: the pinned asset reference the host stamps on a claim from the producing task's work identity. Kept outside
 * `Candidate` on purpose: a claim's attachment to an asset is a host derivation, not a model assertion.
 */
export interface ClaimAssetRef { id: string; revision?: number }

/** R1.2: derive the host-stamped claim assets from a task's pinned work identity (≤10, revision kept when the task pinned it). */
export function claimAssetRefsFromWork(work: { assetRefs?: ReadonlyArray<{ id: string; revision?: number }> } | undefined): ClaimAssetRef[] {
  return (work?.assetRefs ?? []).slice(0, 10).map(ref => ({ id: ref.id, ...(ref.revision === undefined ? {} : { revision: ref.revision }) }));
}
/** Best-effort defensive redaction; exports contain only the bounded receipts, never tickets or process env. */
export function redact(value: string): string {
  return value.replace(/["']?(authorization|proxy-authorization|cookie|set-cookie)["']?\s*:[^\r\n]*/gi, '$1: [REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+(?!(?:tokens?|credentials?|values?)\b)[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)["']?[^\s"'&,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}
/** Redacted and control-stripped: the form every display and export surface applies to model- or target-derived strings. */
export function safeText(value: string): string { return cleanText(redact(value)); }
/**
 * A7.6 (planning_update.md P7.2): the citable excerpt one receipt keeps. The visible tool output cap (48 KiB) and the capture cap
 * are unchanged; a longer observation belongs in a `p2o_capture` artifact, whose ID is cited next to the receipt. Raised from
 * 4000/1000 on purpose: a proof the reader cannot read is not a citable record, and the bound below is what the receipt itself claims.
 */
export const RECEIPT_INPUT_BYTES = 2000, RECEIPT_STDOUT_BYTES = 16 * 1024, RECEIPT_STDERR_BYTES = 4 * 1024;
const bounded = (s: string, n: number) => {
  let result = redactArtifactPrefix(s,redact).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, n);
  while (Buffer.byteLength(JSON.stringify(result)) > n) result = result.slice(0, Math.floor(result.length * 0.75));
  return result;
};
/**
 * A5-fix-1: the excerpt bounds above are per field, but the ledger admits a row of at most `LEDGER_ROW_BYTES`. A receipt that
 * passed every field bound could still exceed the whole-row bound (measured: 15,203-byte stdout + a capture receipt -> a
 * 17,244-byte row), the store refused the append after a successful target return, and the retention path closed the run as a
 * storage failure. The record as a whole is what must fit: shrink the excerpts (command text last) until it does and mark the
 * receipt truncated; the full bytes stay in the cited capture artifact.
 */
const receiptRowBytes = (record: AssessmentRecord): number => Buffer.byteLength(JSON.stringify({ ...record, version: 2 as const })) + 1;
const fitReceipt = (record: AssessmentRecord): AssessmentRecord => {
  if (receiptRowBytes(record) <= LEDGER_ROW_BYTES) return record;
  const data = record.data as Record<string, unknown>;
  data.truncated = true;
  for (const field of ['stdout', 'stderr', 'input'] as const) {
    while (receiptRowBytes(record) > LEDGER_ROW_BYTES && typeof data[field] === 'string' && (data[field] as string).length > 0) {
      data[field] = (data[field] as string).slice(0, Math.floor((data[field] as string).length * 0.75));
    }
  }
  return record;
};

/** P21/A1/A2: one host-recorded replay unit as inherited from a cited receipt. */
interface HostReplayUnit { sha256: string; payloadRef: string; environmentFingerprint: string; receiptId: string }
/**
 * P21/A2: the replay units a claim's cited receipts recorded, deduped by hash in citation order. The first unit is the claim's
 * canonical replay (the first piece of evidence it stands on); every distinct unit stays listed so a reviewer can see the whole
 * replay surface. A receipt that recorded no unit (capture, PTY, research) contributes nothing.
 */
function hostReplayUnits(evidence: readonly AssessmentRecord[], refs: readonly string[]): HostReplayUnit[] {
  const units = new Map<string, HostReplayUnit>();
  for (const id of refs) {
    const replay = evidence.find(row => row.id === id)?.data?.replay as Record<string, unknown> | undefined;
    if (!replay || replay.captured !== true) continue;
    const sha256 = typeof replay.sha256 === 'string' ? replay.sha256 : undefined;
    const payloadRef = typeof replay.payloadRef === 'string' ? replay.payloadRef : undefined;
    const environmentFingerprint = typeof replay.environmentFingerprint === 'string' ? replay.environmentFingerprint : undefined;
    if (!sha256 || !payloadRef || !environmentFingerprint || units.has(sha256)) continue;
    units.set(sha256, { sha256, payloadRef, environmentFingerprint, receiptId: id });
  }
  return [...units.values()];
}
const hostHash = (value: unknown): string => typeof value === 'string' && value.length >= 16 ? value : '';
/** The negative classes the run measured: a limiter/enumeration/uniform-error/absent-session observation needs a positive control. */
const NEGATIVE_CLAIM = /throttl|rate.?limit|enumerat|uniform|no.?session|lockout|limiter|no (?:cookie|jwt|token)/i;

export class EvidenceStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly runId: string, readonly path: string, readonly target: string) {}
  /**
   * P21/A1: `replay` is the host-captured admitted unit for this operation. It is a separate argument, not an input field: no
   * caller can write a replay reference by hand, and a receipt recorded by an older path simply has none.
   */
  async receipt(by: string, operation: string, input: string, result: ProcessResult, startedAt: string, capture?: CaptureReceipt, replay?: ReplayStamp): Promise<string> {
    const id = randomUUID();
    const record: AssessmentRecord = { id, runId: this.runId, at: new Date().toISOString(), by, workerId: by === 'owner' ? undefined : by,
      kind: 'evidence', text: `${operation} exit ${result.code}; untrusted observation, not a finding`,
      data: { operation, receiptRedactionVersion:2, input: bounded(input, RECEIPT_INPUT_BYTES), target: this.target, startedAt, exitCode: result.code,
        ...(result.sessionRef ? { sessionRef: result.sessionRef } : {}), // A7.2: next to http.session, never a claim.
        stdout: bounded(result.stdout, RECEIPT_STDOUT_BYTES), stderr: bounded(result.stderr, RECEIPT_STDERR_BYTES),
        ...(result.hops ? { http: { hops: result.hops.slice(0,6).map(hop => bounded(hop, 256)), session: result.session,
          redirectStopped: result.redirectStopped ? bounded(result.redirectStopped, 1000) : undefined, cookieWarning: result.cookieWarning } } : {}),
        ...(capture ? {capture} : {}),
        ...(replay ? { replay } : {}),
        outputSha256Scope: 'visible-excerpt-before-redaction',
        outputSha256: createHash('sha256').update(result.stdout).update(result.stderr).digest('hex'),
        truncated: result.truncated || result.stdout.length > RECEIPT_STDOUT_BYTES || result.stderr.length > RECEIPT_STDERR_BYTES,
        limitations: 'Bounded redacted tool output; command semantics and claimed effect require review.' } };
    await appendRecord(this.path, fitReceipt(record));
    return id;
  }
  /**
   * R1.2/D-R1-1: `hostAssetRefs` is host-derived from the executing task's pinned work identity. It is a separate argument,
   * not a Candidate field, so no model input can name a claim's assets; a claim recorded without a task (legacy/owner path)
   * stays asset-less and the dossier reports it as such.
   */
  candidate(by: string, input: Candidate, taskRef?: string, hostAssetRefs?: readonly ClaimAssetRef[]): Promise<AssessmentRecord> {
    const task = this.pending.then(async () => {
      // A1: cosmetic prose is clamped at its stored bound with a trace on the record (identity fields keep their strict caps).
      const admissionWarnings = clampProseInPlace(input as unknown as Record<string, unknown>, PROSE_CAPS.candidate);
      // A1: two omissions have one conservative reading. A claim that ran no control has an empty list, and a claim that
      // establishes no closure is open; the host records both, so the stored shape is unchanged.
      const fields = input as unknown as Record<string, unknown>;
      if (fields.negativeControls === undefined) fields.negativeControls = [];
      if (fields.closure === undefined) fields.closure = 'open_proof_gap';
      validateCandidate(input);
      // W4: the host, not the caller, stamps which task produced the claim. It is how the automatic validation task names its
      // predecessor and how a case finds the validation of this exact claim.
      if (taskRef !== undefined && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(taskRef)) throw Error('Invalid candidate task reference');
      const storedInput = { ...input } as Record<string, unknown>;
      delete storedInput.taskRef;
      // R1.2/D-R1-1: host-derived asset refs are validated once, deduped and bounded, so a bad derivation cannot write a claim
      // that points at a foreign or malformed asset id. The model never reaches this argument (see the signature note).
      const claimAssets = [...new Map((hostAssetRefs ?? []).slice(0, 10).map(ref => [ref.id, { id: ref.id, ...(ref.revision === undefined ? {} : { revision: ref.revision }) }])).values()];
      // The host stamp is the only writer: an `assetRefs` field arriving on the input is dropped rather than merged.
      delete storedInput.assetRefs;
      if (claimAssets.some(ref => !/^asset-[a-f0-9]{24}$/.test(ref.id) || (ref.revision !== undefined && (!Number.isSafeInteger(ref.revision) || ref.revision < 1))))
        throw Error('Host claim asset reference must name an asset-<24 hex> id with a positive revision');
      // P14.2/P14.3: a payload or environment reference is a claim that the artifact exists in this run, so a dangling or foreign
      // id fails closed instead of reading as replayable.
      if (input.payloadRef !== undefined && !await payloadExists(this.path, input.payloadRef)) throw new Error(`Unknown payload reference ${input.payloadRef}; store the payload first`);
      if (input.environmentRef !== undefined && !await environmentExists(this.path, input.environmentRef)) throw new Error(`Unknown environment reference ${input.environmentRef}; create the environment first`);
      // Read the artifacts once: their identity is stamped on the claim below and compared when another worker replays it (P14.12).
      const payloadRef = input.payloadRef === undefined ? undefined : (await new PayloadStore(this.path).get(input.payloadRef)).ref;
      const environmentRef = input.environmentRef === undefined ? undefined : await new EnvironmentStore(this.path).get(input.environmentRef);
      const index = await readLedger(this.path, this.runId);
      if (!index.complete) throw new Error('Ledger reconciliation incomplete; candidate closure is blocked');
      const records = index.records;
      // P21/B1: an operator-contract claim cites the policy artifact this run actually recorded. The host refuses a source it
      // cannot resolve and names the recorded id, so the next attempt is not a guess; the artifact body is not read here.
      if (input.policyBasis === 'operator_contract') {
        const policy = campaignFromRecords(records)?.policy;
        if (!policy) throw new Error('POLICY_UNRECORDED: this run recorded no operator policy artifact (--policy), so operator_contract has nothing to cite; legalNext: cite explicit_contract or boundary_invariant when the effect establishes the boundary itself, or keep the claim inferred and open');
        if (input.policyRef !== policy.id) throw new Error(`POLICY_REFERENCE_UNKNOWN: this run recorded ${policySourceLabel(policy)}; cite policyRef=${policy.id} with policyBasis=operator_contract`);
      }
      const evidence = records.filter(r => r.kind === 'evidence' && r.runId === this.runId);
      const references = [...input.evidenceRefs, ...input.negativeControls];
      for (const id of references) if (!evidence.some(r => r.id === id)) throw new Error(`Unknown same-run evidence ID: ${id}`);
      // P21/A2: the replay unit is inherited from the claim's own receipts instead of being stored by the model. The first
      // captured unit is the canonical replay the claim names; every distinct unit still stays recorded. An explicit p2o_lab
      // payload or environment keeps precedence: a stored script's bytes are not the command line that ran it, so they are not
      // compared, but the one field the caller did not name is filled from the host stamp.
      const replayUnits = hostReplayUnits(evidence, input.evidenceRefs);
      const inheritedPayload = isTestedClaim(input) && input.payloadRef === undefined ? replayUnits[0] : undefined;
      const inheritedEnvironment = isTestedClaim(input) && input.environmentRef === undefined ? replayUnits[0] : undefined;
      for (const id of input.resolves ?? []) {
        if (!records.some(r => r.id === id && r.kind === 'open')) throw new Error(`Unknown open-item ID: ${id}`);
        if (isOpenGap(input)) throw new Error('Resolving an open item needs a closed candidate with evidence');
      }
      // P16.6: negative evidence is a checkpoint, not a wall. A second ruled_out for the same surface+capability needs new
      // evidence or a different mechanism ("at most one re-check"); otherwise the earlier negative would be re-litigated
      // forever with the same control, which is exactly the loop ARTEX records as a wasted intent.
      if (isRuledOutClaim(input) && !input.supersedes) {
        const replaced = new Set(records.flatMap(r => r.supersedes ? [r.supersedes] : []));
        const gained = new Set((input.gained ?? []).map(capabilityKey));
        const same = records.filter(row => row.kind === 'candidate' && row.id && !replaced.has(row.id) && row.surface === input.surface && isRuledOutClaim(row.data ?? {})
          && (gained.size ? readCapabilities(row.data?.gained, 'gained').some(capability => gained.has(capabilityKey(capability))) : row.data?.risk === input.risk));
        if (same.length) {
          const cited = new Set(same.flatMap(row => row.refs ?? []));
          const freshEvidence = input.evidenceRefs.some(id => !cited.has(id));
          const control = (input.control ?? '').trim();
          const differentMechanism = control.length > 0 && same.every(row => String(row.data?.control ?? '').trim() !== control);
          if (!freshEvidence && !differentMechanism) throw Error('RULED_OUT_RECHECK: this surface and capability were already ruled out; a second negative needs new evidence or a different control/mechanism (at most one re-check)');
        }
      }
      const previous = records.filter(r => r.kind === 'candidate' && r.data?.candidate === input.candidate).at(-1);
      if (previous && (previous.surface !== input.surface || previous.risk !== input.risk)) throw Error('Candidate revision cannot change surface/risk; use a new candidate ID');
      if (previous && input.supersedes !== previous.id) throw new Error(`Candidate revision must supersede latest ID ${previous.id}`);
      if (input.supersedes && (!previous || input.supersedes !== previous.id)) throw new Error('Invalid candidate revision');
      // P21/A2: one-field validation write-back. `reproduces` names the claim this worker replayed; the host resolves it and
      // stamps the author receipt internally, so the validator never has to assemble the old ref/citation pair (the run's six
      // refusals were all bookkeeping). The legacy independentEvidenceRef path below keeps working unchanged.
      let reproduction: { reproducedClaimRef: string; independentEvidenceRef?: string; matched?: HostReplayUnit } | undefined;
      if (input.reproduces !== undefined) {
        const target = records.find(r => r.id === input.reproduces && r.kind === 'candidate')
          ?? records.filter(r => r.kind === 'candidate' && r.data?.candidate === input.reproduces).at(-1);
        if (!target) throw new Error(`Unknown reproduced claim ${input.reproduces.slice(0, 80)}: pass the claim record id or slug from the validation brief`);
        const targetSlug = String(target.data?.candidate ?? target.id);
        if (!target.workerId || target.by === by)
          throw new Error(`A claim you recorded cannot be reproduced by you: ${targetSlug} was recorded by ${target.by}; reproduces names another worker's demonstrated claim`);
        if (target.surface !== input.surface || target.risk !== input.risk)
          throw new Error(`A reproduction keeps the claim's surface and risk: ${targetSlug} is ${target.surface} / ${target.risk}, this claim says ${input.surface} / ${input.risk}`);
        if (!isDemonstrated(input) || input.proof === 'static_trace')
          throw new Error('reproduces records a reproduction, so closure=confirmed, execution=tested and a non-static proof are required; a failed attempt is an open claim without reproduces');
        if (!isDemonstrated(target.data ?? {}))
          throw new Error(`Claim ${targetSlug} is not a demonstrated claim (closure ${String(target.data?.closure ?? 'unrecorded')}), so it has no effect to reproduce`);
        // The replayer needs at least one receipt it authored: a reproduction without its own evidence is a copy, not a replay.
        const own = input.evidenceRefs.map(id => evidence.find(row => row.id === id)).filter((row): row is AssessmentRecord => !!row && row.by === by && !!row.workerId);
        if (!own.length) {
          const authorRefs = (target.refs ?? []).filter(id => evidence.some(row => row.id === id && row.by === target.by));
          throw new Error(`A reproduction needs your own receipt: cite the receipt you ran in evidenceRefs. ${targetSlug} cites ${authorRefs.slice(0, 3).join(', ') || 'no author receipt'}, which belong to the other worker`);
        }
        const ownUnits = hostReplayUnits(evidence, own.map(row => row.id!));
        const targetUnits = Array.isArray(target.data?.replayUnits) ? target.data.replayUnits as Array<Record<string, unknown>> : [];
        const expected = [...new Set([hostHash(target.data?.payloadSha256), ...targetUnits.map(unit => typeof unit?.sha256 === 'string' ? unit.sha256 : ''), ...hostReplayUnits(evidence, target.refs ?? []).map(unit => unit.sha256)].filter(sha => sha.length >= 16))];
        const matched = expected.length ? ownUnits.find(unit => expected.includes(unit.sha256)) : undefined;
        if (expected.length && !matched)
          throw new Error(`The replay did not run the claim's payload: ${targetSlug} recorded ${expected.slice(0, 2).map(sha => sha.slice(0, 12)).join(' or ')}${expected.length > 2 ? ` (+${expected.length - 2})` : ''}, your receipts recorded ${ownUnits.length ? ownUnits.slice(0, 2).map(unit => unit.sha256.slice(0, 12)).join(', ') : 'no replay unit'}. Replay the exact request with p2o_http (same method, URL, headers and body), or repeat the exact admitted command; a shell replay of a materialized payload records a different unit`);
        // The author's own receipt is what the case's independence check names. A legacy claim that cites none cannot be stamped.
        const authorReceipt = (target.refs ?? []).map(id => evidence.find(row => row.id === id)).find(row => row?.by === target.by && row.workerId)?.id;
        if (!authorReceipt) admissionWarnings.push(`Claim ${targetSlug} cites no receipt by its author, so the case independence path cannot name one; record the reproduction anyway and the limitation stays visible.`);
        reproduction = { reproducedClaimRef: target.id!, ...(authorReceipt ? { independentEvidenceRef: authorReceipt } : {}), ...(matched ? { matched } : {}) };
      } else if (input.independentEvidenceRef) {
        const independent = evidence.find(r => r.id === input.independentEvidenceRef);
        if (!independent) throw new Error(`The independent receipt is not one of your cited evidence IDs: add ${input.independentEvidenceRef} to evidenceRefs`);
        if (!independent.workerId) throw new Error('An owner receipt cannot be independent evidence for a worker claim: independence needs a receipt a different worker authored');
        if (independent.by === by) throw new Error(`Receipt ${independent.id} is your own; independence needs a receipt a different worker authored. Record your own reproduction with reproduces=<claim id from the validation brief>`);
        if (!references.includes(input.independentEvidenceRef)) throw new Error(`The independent receipt must also be cited in evidenceRefs: add ${input.independentEvidenceRef}`);
        // P14.12 + P21/A2: the other worker's claim is whichever claim *it* recorded against that receipt, matching this
        // surface/risk. Filtering by surface/risk first is what stops two claims by one author citing one receipt from
        // cross-matching: the latest claim for a shared receipt is not necessarily the claim this reproduction belongs to.
        const candidates = records.filter(r => r.kind === 'candidate' && r.by === independent.by && r.workerId && r.refs?.includes(independent.id!));
        // Match this surface/risk first: with two claims by one author on one receipt, the latest claim for a *different* surface is
        // not this reproduction's target. Then the latest matching claim decides, so a later non-demonstrated claim is a withdrawal
        // of support rather than a note the older demonstrated claim can talk past.
        const latest = candidates.filter(r => r.surface === input.surface && r.risk === input.risk).at(-1);
        if (!latest) throw new Error(`Independent claim needs the other worker's own demonstrated claim for ${input.surface} / ${input.risk} citing receipt ${independent.id}; record reproduces=<claim id from the validation brief> instead when you are replaying it`);
        if (!isDemonstrated(latest.data ?? {}) || latest.data?.proof === 'static_trace')
          throw new Error(`Independent claim needs the other worker's own demonstrated claim and the receipt it cites: the latest matching claim for ${input.surface} / ${input.risk} is ${String(latest.data?.closure ?? 'unrecorded')} / ${String(latest.data?.execution ?? 'unrecorded')}`);
        // Independence means the same effect was reproduced: same payload bytes and same environment recipe, or the claim is refused.
        // A claim that names no artifact has nothing to replay, so its independence stays the peer's own demonstrated claim above.
        if (payloadRef || environmentRef) {
          if (!payloadRef) throw new Error('Independent validation needs the payload that ran: record payloadRef so a second worker can replay the same bytes');
          if (latest.data?.payloadSha256 !== payloadRef.sha256) throw new Error(`Independent replay mismatch: the other worker ran ${String(latest.data?.payloadSha256 ?? 'an unrecorded payload').slice(0, 12)}, this claim ran ${payloadRef.sha256.slice(0, 12)}`);
          if (!environmentRef) throw new Error('Independent validation needs the environment it ran in: record environmentRef so the fingerprint can be compared');
          if (latest.data?.environmentFingerprint !== environmentRef.fingerprint) throw new Error(`Independent replay environment drifted: ${String(latest.data?.environmentFingerprint ?? 'unrecorded').slice(0, 12)} vs ${environmentRef.fingerprint.slice(0, 12)}`);
        }
      }
      // P21/A2 host stamps: explicit artifacts win; otherwise the canonical host unit supplies the payload hash and the host-derived
      // environment fingerprint, so an http/net claim is replayable with no p2o_lab calls. Every distinct unit is recorded either way.
      const hostStamp: Record<string, unknown> = {};
      if (replayUnits.length) hostStamp.replayUnits = replayUnits.slice(0, 8);
      if (payloadRef) hostStamp.payloadSha256 = payloadRef.sha256;
      else if (inheritedPayload) { hostStamp.payloadSha256 = inheritedPayload.sha256; hostStamp.payloadRef = inheritedPayload.payloadRef; }
      if (environmentRef) hostStamp.environmentFingerprint = environmentRef.fingerprint;
      else if (inheritedEnvironment) hostStamp.environmentFingerprint = inheritedEnvironment.environmentFingerprint;
      if (reproduction) {
        hostStamp.reproducedClaimRef = reproduction.reproducedClaimRef;
        if (reproduction.independentEvidenceRef) hostStamp.independentEvidenceRef = reproduction.independentEvidenceRef;
        if (reproduction.matched) { hostStamp.payloadSha256 = reproduction.matched.sha256; hostStamp.payloadRef = reproduction.matched.payloadRef; hostStamp.environmentFingerprint = reproduction.matched.environmentFingerprint; }
      }
      if (isTestedClaim(input) && input.evidenceRefs.length && !replayUnits.length && input.payloadRef === undefined)
        admissionWarnings.push('No cited receipt recorded a replay unit, so this claim is not replayable: cite the target-operation receipt that ran it (capture- and PTY-only receipts record no unit), or store the exact bytes with p2o_lab.');
      // P21/A4: a negative observation without a discriminating control cannot tell "the guard held" from "the request never
      // reached the guard". The run's no-throttle claim sent identifier-less bodies that hit NextAuth's missing-credential
      // short-circuit and was disputed at review. A warning, not a refusal: the evidence ladder does not change.
      if (isDemonstrated(input) && input.negativeControls.length === 0 && NEGATIVE_CLAIM.test(`${input.candidate} ${input.surface} ${input.risk} ${input.expectedPolicy ?? ''}`))
        admissionWarnings.push('negative claim without a discriminating control: name the positive control that proves the request reached the claimed mechanism, not a short-circuit before it');
      const record: AssessmentRecord = { id: randomUUID(), version: 2, runId: this.runId, at: new Date().toISOString(), by,
        workerId: by === 'owner' ? undefined : by, kind: 'candidate', text: `${input.candidate}: ${input.closure} (${input.execution}, ${input.proof}); agent claim, not automatic verification`,
        surface: input.surface, risk: input.risk, outcome: input.closure, refs: input.evidenceRefs,
        supersedes: input.supersedes, resolves: input.resolves,
        // Stamped after the spread, so a caller cannot claim a payload hash or origin task it did not run.
        data: { ...storedInput, ...(admissionWarnings.length ? { admissionWarnings } : {}), ...(taskRef ? { taskRef } : {}), ...(claimAssets.length ? { assetRefs: claimAssets } : {}), ...hostStamp } };
      await appendRecord(this.path, record);
      return record;
    });
    this.pending = task.catch(() => {});
    return task;
  }
  async exportTo(cwd: string, manifest: Record<string, unknown>): Promise<string> {
    await this.pending;
    const directory = join(cwd, '.p2o-reports');
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    return this.writeExport(directory, manifest);
  }
  private async writeExport(directory: string, manifest: Record<string, unknown>): Promise<string> {
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (((await dir.stat()).mode & 0o777) !== 0o700) throw new Error('Export directory must have mode 0700');
      const index = await readLedger(this.path, this.runId);
      const records = index.records;
      if (!records.length) throw new Error('Cannot export an empty assessment ledger');
      const payload = { version: 2, runId: this.runId, manifest, records,
        reconciliation: { complete: index.complete, total: records.length, diagnostics: index.diagnostics, foreign: index.foreign },
        warning: 'Redaction is best effort; review before sharing. Candidate records are attributed claims, not verified findings.' };
      // Walk string values rather than a serialized JSON string, so redaction cannot corrupt JSON framing.
      const reportPartData = new Set(records.filter(r => r.kind === 'report_part').map(r => r.data));
      const clean = (v: unknown): unknown => typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(clean)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x]) => {
          // Report parts contain serialized JSON whose fields were redacted before chunking/hashing.
          // Redacting the encoded fragment again would destroy framing and invalidate its manifest.
          const part = (v as Record<string,unknown>);
          return [k, k === 'value' && reportPartData.has(v as Record<string,unknown>) && part.redacted === true && typeof x === 'string' && part.sha256 === sha256Hex(x) ? x : clean(x)];
        })) : v;
      const body = JSON.stringify(clean(payload), null, 2);
      if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error('Export exceeds 16 MiB; cleanup will still proceed');
      const name = `${this.runId}-${randomUUID()}.json`;
      const file = await open(`/proc/self/fd/${dir.fd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      return join(directory, name);
    } finally { await dir.close(); }
  }
}
function validateCandidate(c: Candidate): void {
  if (!c || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(c.candidate) || !c.surface || !c.risk || !c.limitations) throw new Error('Candidate needs id, surface, risk and limitations');
  if (!(CANDIDATE_CLOSURES as readonly string[]).includes(c.closure) || !(CANDIDATE_EXECUTIONS as readonly string[]).includes(c.execution)
    || !(CANDIDATE_PROOFS as readonly string[]).includes(c.proof)) throw new Error('Invalid candidate state');
  if (!Array.isArray(c.evidenceRefs) || !Array.isArray(c.negativeControls)) throw new Error('Evidence arrays must be lists of receipt IDs');
  // P16.4: version→CVE is a lead. It may shape a hypothesis, never settle one: the claim stays open until the effect ran.
  if (c.leadRefs !== undefined) {
    if (!Array.isArray(c.leadRefs) || c.leadRefs.some(id => typeof id !== 'string' || !id)) throw new Error('leadRefs must be a list of same-run lead record IDs');
    // The execution rule is checked first: a confirmed claim that cites a lead is the exact error this gate exists for.
    if (c.leadRefs.length && isConfirmedClaim(c)) throw new Error('LEAD_NOT_EVIDENCE: a CVE lead names a published issue, not an executed effect; keep the claim open_proof_gap until the effect is demonstrated');
    if (c.leadRefs.length && c.policyBasis !== 'inferred') throw new Error('A CVE lead is not intended-policy provenance: cite it as policyBasis "inferred"');
  }

  // P21/A2: `reproduces` is the one-field validation write-back, so its shape is validated here and resolved in `candidate()`.
  if (c.reproduces !== undefined && (typeof c.reproduces !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(c.reproduces)))
    throw new Error('Invalid reproduced claim: pass the claim record id or its candidate slug');
  if (c.reproduces !== undefined && c.independentEvidenceRef !== undefined)
    throw new Error('Record one independence path: reproduces names the claim you replayed, independentEvidenceRef cites a peer receipt; they are alternatives');
  if (c.reproduces !== undefined && c.execution !== 'tested')
    throw new Error('reproduces records a reproduction, so execution must be tested');
  if (!(POLICY_BASES as readonly string[]).includes(c.policyBasis ?? '')) throw new Error('Invalid policy basis');
  // P21/B1: operator_contract is provenance with a host-resolvable source, never a shortcut around the evidence ladder.
  if (c.policyRef !== undefined) {
    if (typeof c.policyRef !== 'string' || !c.policyRef.length || c.policyRef.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(c.policyRef))
      throw new Error('Invalid policy reference: pass the run policy artifact id the host recorded (an absolute --policy path or a standard name)');
    if (c.policyBasis !== 'operator_contract') throw new Error('policyRef records operator policy provenance, so policyBasis must be operator_contract');
  }
  if (c.policyBasis === 'operator_contract' && c.policyRef === undefined)
    throw new Error('POLICY_UNRECORDED: operator_contract needs policyRef naming the run policy artifact; legalNext: start the run with --policy and cite the id it records, or use explicit_contract/boundary_invariant when the effect establishes the boundary itself');
  if (!c.expectedPolicy?.trim()) throw new Error('Name the expected policy and its provenance');
  // A1: the prose clamp stores at most 1000 characters; a value it left alone (control text) is still refused, never stored over-bound.
  if (c.expectedPolicy.length > 1000) throw new Error('Invalid expected policy (1..1000 characters)');
  // D35: policy provenance is not a ceiling by itself, but inference is not proof either. An inferred claim stays a hypothesis
  // until the effect itself was tested and observed; only then may it be confirmed while its basis stays inferred.
  if (c.policyBasis === 'inferred' && !isOpenGap(c) && !(isDemonstrated(c) && c.proof !== 'static_trace'))
    throw new Error('Inferred policy is a hypothesis: use open_proof_gap until intended policy is established or the effect is tested and observed');
  if (c.closure !== 'open_proof_gap' && !c.evidenceRefs.length) throw new Error('Closure needs evidence; otherwise use open_proof_gap');
  if (c.closure === 'ruled_out' && !c.control?.trim()) throw new Error('ruled_out needs the specific control and its location');
  if (c.resolves && (!Array.isArray(c.resolves) || c.resolves.some(id => typeof id !== 'string'))) throw new Error('Invalid resolved open-item list');
  if (c.requirement !== undefined && (typeof c.requirement !== 'string' || !c.requirement.trim() || c.requirement.length > 1000)) throw new Error('Invalid blocked prerequisite reason');
  // The pre-P14 text fields are refused rather than ignored: silently dropping them would leave a claim that looks like it names a
  // capability edge while declaring none.
  if ('provides' in c || 'requires' in c) throw new Error('Candidate capabilities are typed: send gained/needs, not the pre-P14 provides/requires text');
  // Validated through the one constructor and assigned back, so the record holds the canonical order and dedup (same rule as P9).
  if (c.gained !== undefined) c.gained = capabilityList(c.gained, 'candidate gained');
  if (c.needs !== undefined) c.needs = capabilityList(c.needs, 'candidate needs');
  if (c.note !== undefined && (typeof c.note !== 'string' || !c.note.trim() || c.note.length > 300)) throw new Error('Invalid capability note (1..300 characters)');
  // A payload is what ran, so it only makes sense on a claim that ran something; the derived `replayable` reads this field and
  // never a stored flag (P14.2), and P14.3 adds the environment to the same derivation.
  if (c.payloadRef !== undefined && (typeof c.payloadRef !== 'string' || !isPayloadId(c.payloadRef))) throw new Error('Invalid payload reference: expected payload-<uuid> from p2o_lab action=payload');
  if (c.payloadRef !== undefined && c.execution !== 'tested') throw new Error('A payload reference requires tested execution');
  if (c.environmentRef !== undefined && (typeof c.environmentRef !== 'string' || !isEnvironmentId(c.environmentRef))) throw new Error('Invalid environment reference: expected env-<uuid> from p2o_lab action=env');
  if (c.environmentRef !== undefined && c.execution !== 'tested') throw new Error('An environment reference requires tested execution');
  if (c.execution === 'blocked' && (c.requirement?.trim().length ?? 0) < 10) throw new Error('blocked needs a descriptive prerequisite reason (10..1000 characters)');
  if (c.execution === 'blocked' && c.closure !== 'open_proof_gap') throw new Error('Blocked execution cannot establish closure');
  if (c.proof !== 'static_trace' && c.execution !== 'tested') throw new Error('Runtime proof requires tested execution');
}

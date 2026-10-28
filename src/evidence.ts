import { randomUUID, createHash } from 'node:crypto';
import { clampProseInPlace, PROSE_CAPS, sha256Hex } from './validate.js';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { appendRecord, readLedger, type AssessmentRecord } from './records.js';
import { isConfirmedClaim, isDemonstrated, isOpenGap, isRuledOutClaim } from './claims.js';
import { capabilityKey, readCapabilities } from './capabilities.js';
import { cleanText, type ProcessResult } from './process.js';
import { redactArtifactPrefix, type CaptureReceipt } from './artifacts.js';
import { capabilityList, type Capability } from './capabilities.js';
import { EnvironmentStore, PayloadStore, environmentExists, isEnvironmentId, isPayloadId, payloadExists } from './lab.js';

export const CANDIDATE_CLOSURES = ['confirmed', 'ruled_out', 'open_proof_gap'] as const;
export const CANDIDATE_EXECUTIONS = ['tested', 'not_tested', 'blocked', 'not_applicable'] as const;
export const CANDIDATE_PROOFS = ['static_trace', 'offline_reproduction', 'live_reproduction'] as const;
export const POLICY_BASES = ['explicit_contract', 'boundary_invariant', 'inferred'] as const;
export interface Candidate {
  candidate: string; surface: string; risk: string;
  closure: typeof CANDIDATE_CLOSURES[number];
  execution: typeof CANDIDATE_EXECUTIONS[number];
  proof: typeof CANDIDATE_PROOFS[number];
  evidenceRefs: string[]; negativeControls: string[]; limitations: string;
  policyBasis?: typeof POLICY_BASES[number]; expectedPolicy?: string;
  control?: string; requirement?: string; supersedes?: string; independentEvidenceRef?: string; resolves?: string[];
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

export class EvidenceStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly runId: string, readonly path: string, readonly target: string) {}
  async receipt(by: string, operation: string, input: string, result: ProcessResult, startedAt: string, capture?: CaptureReceipt): Promise<string> {
    const id = randomUUID();
    await appendRecord(this.path, { id, runId: this.runId, at: new Date().toISOString(), by, workerId: by === 'owner' ? undefined : by,
      kind: 'evidence', text: `${operation} exit ${result.code}; untrusted observation, not a finding`,
      data: { operation, receiptRedactionVersion:2, input: bounded(input, RECEIPT_INPUT_BYTES), target: this.target, startedAt, exitCode: result.code,
        ...(result.sessionRef ? { sessionRef: result.sessionRef } : {}), // A7.2: next to http.session, never a claim.
        stdout: bounded(result.stdout, RECEIPT_STDOUT_BYTES), stderr: bounded(result.stderr, RECEIPT_STDERR_BYTES),
        ...(result.hops ? { http: { hops: result.hops.slice(0,6).map(hop => bounded(hop, 256)), session: result.session,
          redirectStopped: result.redirectStopped ? bounded(result.redirectStopped, 1000) : undefined, cookieWarning: result.cookieWarning } } : {}),
        ...(capture ? {capture} : {}),
        outputSha256Scope: 'visible-excerpt-before-redaction',
        outputSha256: createHash('sha256').update(result.stdout).update(result.stderr).digest('hex'),
        truncated: result.truncated || result.stdout.length > RECEIPT_STDOUT_BYTES || result.stderr.length > RECEIPT_STDERR_BYTES,
        limitations: 'Bounded redacted tool output; command semantics and claimed effect require review.' } });
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
      const evidence = records.filter(r => r.kind === 'evidence' && r.runId === this.runId);
      const references = [...input.evidenceRefs, ...input.negativeControls];
      for (const id of references) if (!evidence.some(r => r.id === id)) throw new Error(`Unknown same-run evidence ID: ${id}`);
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
      if (input.independentEvidenceRef) {
        const independent = evidence.find(r => r.id === input.independentEvidenceRef);
        if (!independent?.workerId || independent.by === by || !references.includes(input.independentEvidenceRef)) throw new Error('Independent validation needs a cited receipt from a different worker');
        // P14.12: the other worker's claim is whichever claim *it* recorded against that receipt — not a copy of this claim's slug,
        // which could only be produced by superseding this claim.
        const latest = records.filter(r => r.kind === 'candidate' && r.by === independent.by && r.workerId && r.refs?.includes(independent.id!)).at(-1);
        const reproduced = latest && latest.surface === input.surface && latest.risk === input.risk && isDemonstrated(latest.data ?? {})
          && latest.data?.proof !== 'static_trace';
        if (!reproduced) throw new Error('Independent claim needs the other worker\'s own demonstrated claim and the receipt it cites');
        // Independence means the same effect was reproduced: same payload bytes and same environment recipe, or the claim is refused.
        // A claim that names no artifact has nothing to replay, so its independence stays the peer's own demonstrated claim above.
        if (payloadRef || environmentRef) {
          if (!payloadRef) throw new Error('Independent validation needs the payload that ran: record payloadRef so a second worker can replay the same bytes');
          if (latest.data?.payloadSha256 !== payloadRef.sha256) throw new Error(`Independent replay mismatch: the other worker ran ${String(latest.data?.payloadSha256 ?? 'an unrecorded payload').slice(0, 12)}, this claim ran ${payloadRef.sha256.slice(0, 12)}`);
          if (!environmentRef) throw new Error('Independent validation needs the environment it ran in: record environmentRef so the fingerprint can be compared');
          if (latest.data?.environmentFingerprint !== environmentRef.fingerprint) throw new Error(`Independent replay environment drifted: ${String(latest.data?.environmentFingerprint ?? 'unrecorded').slice(0, 12)} vs ${environmentRef.fingerprint.slice(0, 12)}`);
        }
      }
      const record: AssessmentRecord = { id: randomUUID(), version: 2, runId: this.runId, at: new Date().toISOString(), by,
        workerId: by === 'owner' ? undefined : by, kind: 'candidate', text: `${input.candidate}: ${input.closure} (${input.execution}, ${input.proof}); agent claim, not automatic verification`,
        surface: input.surface, risk: input.risk, outcome: input.closure, refs: input.evidenceRefs,
        supersedes: input.supersedes, resolves: input.resolves,
        // Stamped after the spread, so a caller cannot claim a payload hash or origin task it did not run.
        data: { ...storedInput, ...(admissionWarnings.length ? { admissionWarnings } : {}), ...(taskRef ? { taskRef } : {}), ...(claimAssets.length ? { assetRefs: claimAssets } : {}), ...(payloadRef ? { payloadSha256: payloadRef.sha256 } : {}), ...(environmentRef ? { environmentFingerprint: environmentRef.fingerprint } : {}) } };
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

  if (!(POLICY_BASES as readonly string[]).includes(c.policyBasis ?? '')) throw new Error('Invalid policy basis');
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

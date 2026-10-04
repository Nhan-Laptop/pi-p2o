import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, unlinkSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  canonicalJson, classifications, digestJson, evidenceKinds, evidenceSchema, makeSchema, rules as r,
  type Classification, type EvidenceKind, type EvidenceReceipt, type JsonObject, type TestReceipt,
} from '../contracts/index.js';
import { checkId, checkTime, digestRule, EvidenceError, freeze, idRule, requireEvidence, sha256, snapshot, timeRule } from './common.js';
import { checkedDirectory, isWithin, makePrivateDirectory, readBoundedArtifact, syncDirectory, writeExclusive } from './filesystem.js';
import { createEvidenceRedactor, type EvidenceRedactor } from './redaction.js';

export interface EvidenceLimits { maxArtifactBytes: number; maxTotalBytes: number; maxReceipts: number; maxReceiptBytes: number; maxAgeMs: number }
export interface EvidenceVaultOptions {
  root: string;
  artifactRoots: Readonly<Record<string, string>>;
  /** All roots to which workers have write authority; supervisor must enumerate them honestly. */
  workerWriteRoots: readonly string[];
  knownSecrets?: readonly string[];
  limits?: Partial<EvidenceLimits>;
  clock?: () => string;
}
export interface CollectorGrant {
  collectorId: string;
  role: 'collector' | 'verifier';
  runId: string; taskId: string; attemptId: string;
  authorizationRef: string;
  environmentId: string;
  configurationDigest: string;
  scopeDigest: string;
  inputDigests: string[];
  originalEnvironment: boolean;
  modifications: string[];
  toolGrantId: string;
  tool: { name: string; version: string; implementationDigest: string };
  artifactRootIds: string[];
  allowedKinds: EvidenceKind[];
  allowedClassifications: Classification[];
  validFrom: string; expiresAt: string;
}
/** An in-process supervisor capability, deliberately not serializable/authenticatable by a string ID. */
export interface CollectorHandle { readonly capability: 'supervisor-collector' }
export interface EvidenceSubmission {
  evidenceId: string; idempotencyKey: string;
  artifact: { rootId: string; path: string; expectedDigest: string; expectedBytes: number; mediaType: string };
  operationInputDigest: string;
  kind: EvidenceKind; classification: Classification; summary: string;
  collectedAt: string; method: string; toolOptions: string[];
  originalEnvironment: boolean; modifications: string[];
  test?: TestReceipt;
  artifactIdentity?: NonNullable<EvidenceReceipt['artifact']>;
  deployment?: NonNullable<EvidenceReceipt['deployment']>;
  analysis?: NonNullable<EvidenceReceipt['analysis']>;
  metadata?: JsonObject;
}
export interface AdmissionRecord {
  version: 1;
  keyDigest: string;
  admissionDigest: string;
  admittedAt: string;
  receipt: EvidenceReceipt;
  originalDigest: string;
  originalBytes: number;
  redactionPolicyDigest: string;
  collector: { identity: string; role: CollectorGrant['role']; grantDigest: string; toolImplementationDigest: string; operationInputDigest: string; scopeDigest: string; authorizationDigest: string; validFrom: string; expiresAt: string };
  limits: EvidenceLimits;
}
export interface EvidenceAdmission { status: 'accepted'; receipt: EvidenceReceipt; duplicate: boolean }
export type EvidenceAdmissionOutcome = EvidenceAdmission | { status: 'rejected'; code: string; reason: string };
const texts = r.array(r.string(), 0, true);
const grantSchema = makeSchema<CollectorGrant>('collector-grant', r.object({
  collectorId: idRule, role: r.enum(['collector', 'verifier']), runId: idRule, taskId: idRule, attemptId: idRule,
  authorizationRef: r.string(), environmentId: idRule, configurationDigest: digestRule, scopeDigest: digestRule,
  originalEnvironment: r.boolean(), modifications: texts,
  inputDigests: r.array(digestRule, 1, true), toolGrantId: idRule, tool: r.object({ name: r.string(), version: r.string(), implementationDigest: digestRule }),
  artifactRootIds: r.array(idRule, 1, true), allowedKinds: r.array(r.enum(evidenceKinds), 1, true),
  allowedClassifications: r.array(r.enum(classifications), 1, true), validFrom: timeRule, expiresAt: timeRule,
}));
const submissionSchema = makeSchema<EvidenceSubmission>('evidence-submission', r.object({
  evidenceId: idRule, idempotencyKey: idRule,
  artifact: r.object({ rootId: idRule, path: r.string({ maxLength: 4096 }), expectedDigest: digestRule, expectedBytes: r.number(true), mediaType: r.string({ maxLength: 128 }) }),
  operationInputDigest: digestRule, kind: r.enum(evidenceKinds), classification: r.enum(classifications), summary: r.string(),
  collectedAt: timeRule, method: r.string(), toolOptions: texts, originalEnvironment: r.boolean(), modifications: texts,
  test: r.optional(r.jsonObject()), artifactIdentity: r.optional(r.jsonObject()), deployment: r.optional(r.jsonObject()), analysis: r.optional(r.jsonObject()), metadata: r.optional(r.jsonObject()),
}));
const DEFAULT_LIMITS: EvidenceLimits = { maxArtifactBytes: 1_048_576, maxTotalBytes: 67_108_864, maxReceipts: 4096, maxReceiptBytes: 262_144, maxAgeMs: 300_000 };
const limitsSchema = makeSchema<EvidenceLimits>('evidence-limits', r.object({
  maxArtifactBytes: r.number(true, 1, 16_777_216), maxTotalBytes: r.number(true, 1, 1_073_741_824),
  maxReceipts: r.number(true, 1, 10_000), maxReceiptBytes: r.number(true, 1024, 2_000_000), maxAgeMs: r.number(true, 1, 86_400_000),
}));

export class EvidenceVault {
  readonly root: string;
  readonly limits: Readonly<EvidenceLimits>;
  readonly redactor: EvidenceRedactor;
  private readonly roots: Readonly<Record<string, string>>;
  private readonly rootIdentity: Stats;
  private readonly writerIdentity: Stats;
  private readonly key: Buffer;
  private readonly grants = new WeakMap<object, CollectorGrant>();
  private readonly records = new Map<string, AdmissionRecord>();
  private readonly receiptKeys = new Map<string, string>();
  private readonly clock: () => string;
  private highWater = -Infinity;
  private closed = false;

  constructor(options: EvidenceVaultOptions) {
    requireEvidence(isAbsolute(options.root) && resolve(options.root) === options.root && options.root !== '/', 'private-root', 'Vault needs a private canonical absolute root');
    this.root = options.root;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.limits = freeze(limitsSchema.parse({ ...DEFAULT_LIMITS, ...options.limits }));
    requireEvidence(this.limits.maxArtifactBytes <= this.limits.maxTotalBytes, 'limit', 'Artifact limit exceeds total vault budget');
    this.redactor = createEvidenceRedactor(options.knownSecrets);
    const roots: Record<string, string> = {};
    requireEvidence(Array.isArray(options.workerWriteRoots) && Object.keys(options.artifactRoots).length > 0 && Object.keys(options.artifactRoots).length <= 128, 'private-root', 'Explicit worker and artifact roots are required');
    for (const [id, path] of Object.entries(options.artifactRoots)) {
      checkId(id); checkedDirectory(path);
      requireEvidence(!isWithin(path, this.root) && !isWithin(this.root, path), 'private-root', 'Preserved evidence and collection roots must be disjoint');
      roots[id] = path;
    }
    for (const path of options.workerWriteRoots) {
      checkedDirectory(path);
      requireEvidence(!isWithin(path, this.root) && !isWithin(this.root, path), 'private-root', 'Evidence must be outside every worker-writable root');
    }
    this.roots = freeze(roots);
    makePrivateDirectory(this.root);
    this.rootIdentity = checkedDirectory(this.root, true);
    try { writeExclusive(join(this.root, '.writer'), randomBytes(32), 0o600); }
    catch { throw new EvidenceError('vault-busy', 'Vault has an existing supervisor writer; reconcile it, never blindly steal its lock'); }
    this.writerIdentity = lstatSync(join(this.root, '.writer'));
    try {
      makePrivateDirectory(join(this.root, 'artifacts')); makePrivateDirectory(join(this.root, 'records'));
      if (!existsSync(join(this.root, '.integrity-key'))) writeExclusive(join(this.root, '.integrity-key'), randomBytes(32));
      this.key = readBoundedArtifact(this.root, '.integrity-key', 32, true);
      requireEvidence(this.key.length === 32, 'vault-integrity', 'Invalid vault integrity material');
      const policy = { version: 1, redactionPolicyDigest: this.redactor.policyDigest };
      if (!existsSync(join(this.root, '.policy.json'))) this.writeSigned('.policy.json', policy);
      requireEvidence(canonicalJson(this.readSigned('.policy.json')) === canonicalJson(policy), 'redaction-policy', 'A vault cannot silently change redaction policy; use a new vault or an explicit migration');
      const names = readdirSync(join(this.root, 'records')).sort();
      requireEvidence(names.length <= this.limits.maxReceipts && names.every(n => /^[a-f0-9]{64}\.json$/.test(n)), 'vault-integrity', 'Unexpected or excess admission records');
      for (const name of names) {
        const record = this.parseRecord(this.readSigned(`records/${name}`));
        requireEvidence(name === `${record.keyDigest}.json` && !this.receiptKeys.has(record.receipt.evidenceId), 'vault-integrity', 'Conflicting immutable admission identities');
        this.records.set(record.keyDigest, freeze(record)); this.receiptKeys.set(record.receipt.evidenceId, record.keyDigest);
        this.artifactBytes(record.receipt);
      }
      this.assertBudget();
    } catch (e) { unlinkSync(join(this.root, '.writer')); syncDirectory(this.root); throw e; }
  }
  private now(): string {
    const time = this.clock(), n = checkTime(time);
    requireEvidence(n >= this.highWater, 'clock-regressed', 'Collection clock regressed; evidence admission is stopped');
    this.highWater = n;
    return time;
  }
  private active(): void {
    requireEvidence(!this.closed, 'vault-closed', 'Evidence vault is closed');
    const s = checkedDirectory(this.root, true), w = lstatSync(join(this.root, '.writer'));
    requireEvidence(s.ino === this.rootIdentity.ino && s.dev === this.rootIdentity.dev && w.ino === this.writerIdentity.ino && w.dev === this.writerIdentity.dev && !w.isSymbolicLink() && w.nlink === 1, 'vault-integrity', 'Supervisor evidence root/writer identity changed');
  }
  private seal(value: unknown): string { return createHmac('sha256', this.key).update(canonicalJson(value)).digest('hex'); }
  private writeSigned(path: string, body: unknown): void {
    const bytes = Buffer.from(canonicalJson({ body, seal: this.seal(body) }));
    requireEvidence(bytes.length <= this.limits.maxReceiptBytes, 'receipt-limit', 'Integrity record exceeds receipt limit');
    writeExclusive(join(this.root, path), bytes);
  }
  private readSigned(path: string): unknown {
    const content = readBoundedArtifact(this.root, path, this.limits.maxReceiptBytes, true);
    let parsed: unknown;
    try { parsed = JSON.parse(content.toString('utf8')); } catch { throw new EvidenceError('vault-integrity', 'Corrupt integrity record'); }
    const signed = makeSchema<{ body: JsonObject; seal: string }>('signed-evidence', r.object({ body: r.jsonObject(), seal: digestRule })).parse(parsed);
    const expected = Buffer.from(this.seal(signed.body), 'hex'), actual = Buffer.from(signed.seal, 'hex');
    requireEvidence(timingSafeEqual(expected, actual), 'vault-integrity', 'Evidence integrity seal does not match');
    return signed.body;
  }
  private parseRecord(value: unknown): AdmissionRecord {
    const record = snapshot(value) as AdmissionRecord;
    requireEvidence(record.version === 1 && /^[a-f0-9]{64}$/.test(record.keyDigest) && /^[a-f0-9]{64}$/.test(record.admissionDigest), 'vault-integrity', 'Invalid integrity-record identity');
    record.receipt = evidenceSchema.parse(record.receipt); limitsSchema.parse(record.limits);
    checkTime(record.admittedAt); checkTime(record.collector.validFrom); checkTime(record.collector.expiresAt);
    requireEvidence(record.receipt.provenance.trust === 'collector' && record.receipt.provenance.collectorId === record.collector.identity && record.redactionPolicyDigest === this.redactor.policyDigest && record.receipt.locator === `artifacts/${record.receipt.digest}.blob`, 'vault-integrity', 'Receipt is not bound to preserved collector evidence');
    return record;
  }
  private assertBudget(): number {
    const names = readdirSync(join(this.root, 'artifacts'));
    requireEvidence(names.length <= this.limits.maxReceipts && names.every(n => /^[a-f0-9]{64}\.blob$/.test(n)), 'vault-integrity', 'Unexpected or excess preserved artifacts');
    let bytes = 0;
    for (const name of names) {
      const s = lstatSync(join(this.root, 'artifacts', name));
      requireEvidence(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && (s.mode & 0o077) === 0 && s.size <= this.limits.maxArtifactBytes, 'vault-integrity', 'Unsafe preserved artifact');
      bytes += s.size;
    }
    requireEvidence(bytes <= this.limits.maxTotalBytes, 'vault-limit', 'Vault total byte budget exceeded');
    return bytes;
  }
  private artifactBytes(receipt: EvidenceReceipt): Buffer {
    const bytes = readBoundedArtifact(this.root, receipt.locator, this.limits.maxArtifactBytes, true);
    requireEvidence(bytes.length === receipt.byteLength && sha256(bytes) === receipt.digest, 'artifact-integrity', 'Preserved artifact bytes no longer match the admitted receipt');
    return bytes;
  }
  /** Only the trusted supervisor may call this. A role name, worker JSON, or receipt field is not authentication. */
  issueCollector(input: CollectorGrant): CollectorHandle {
    this.active();
    const grant = grantSchema.parse(input), now = checkTime(this.now());
    requireEvidence(checkTime(grant.validFrom) <= now && now < checkTime(grant.expiresAt), 'collector-expired', 'Collector grant is inactive');
    requireEvidence(grant.artifactRootIds.every(id => Object.hasOwn(this.roots, id)), 'collector-root', 'Collector requests an unapproved collection root');
    const handle: CollectorHandle = Object.freeze({ capability: 'supervisor-collector' });
    this.grants.set(handle, freeze(grant));
    return handle;
  }
  collectorGrant(handle: CollectorHandle): Readonly<CollectorGrant> {
    this.active();
    const grant = this.grants.get(handle);
    requireEvidence(grant, 'collector-authentication', 'No supervisor-issued collector capability exists');
    return grant;
  }
  readCollected(handle: CollectorHandle, artifact: EvidenceSubmission['artifact']): Buffer {
    const grant = this.collectorGrant(handle);
    requireEvidence(grant.artifactRootIds.includes(artifact.rootId), 'collector-root', 'Collection root is outside collector authority');
    const bytes = readBoundedArtifact(this.roots[artifact.rootId], artifact.path, this.limits.maxArtifactBytes);
    requireEvidence(bytes.length === artifact.expectedBytes && sha256(bytes) === artifact.expectedDigest, 'artifact-integrity', 'Collected bytes do not match collector identity');
    return bytes;
  }
  admit(handle: CollectorHandle, input: EvidenceSubmission): EvidenceAdmission {
    const grant = this.collectorGrant(handle), submission = submissionSchema.parse(input);
    const keyDigest = digestJson({ runId: grant.runId, collectorId: grant.collectorId, idempotencyKey: submission.idempotencyKey });
    const admissionDigest = digestJson({ grant, submission, redactionPolicyDigest: this.redactor.policyDigest });
    const existing = this.records.get(keyDigest);
    if (existing) {
      requireEvidence(existing.admissionDigest === admissionDigest, 'idempotency-conflict', 'Idempotency key is bound to different content or collection identity');
      return freeze({ status: 'accepted', receipt: this.get(existing.receipt.evidenceId)!, duplicate: true });
    }
    const now = this.now(), collected = checkTime(submission.collectedAt);
    requireEvidence(checkTime(grant.validFrom) <= collected && collected <= checkTime(now) && collected < checkTime(grant.expiresAt) && checkTime(now) < checkTime(grant.expiresAt) && checkTime(now) - collected <= this.limits.maxAgeMs, 'stale-evidence', 'Evidence is stale, future-dated, or outside its collector grant');
    requireEvidence(submission.originalEnvironment === grant.originalEnvironment && canonicalJson(submission.modifications) === canonicalJson(grant.modifications), 'environment-modification', 'Original versus modified environment must match the supervisor collection grant');
    requireEvidence(grant.allowedKinds.includes(submission.kind) && grant.allowedClassifications.includes(submission.classification), 'collector-purpose', 'Collector is not authorized for this evidence kind/classification');
    requireEvidence(grant.artifactRootIds.includes(submission.artifact.rootId), 'collector-root', 'Artifact root is outside the collector grant');
    requireEvidence(!this.receiptKeys.has(submission.evidenceId), 'evidence-conflict', 'Evidence ID is already immutable; use the original idempotency key');
    requireEvidence(this.records.size < this.limits.maxReceipts, 'vault-limit', 'Vault receipt budget exhausted');
    const raw = readBoundedArtifact(this.roots[submission.artifact.rootId], submission.artifact.path, this.limits.maxArtifactBytes);
    requireEvidence(raw.length === submission.artifact.expectedBytes && sha256(raw) === submission.artifact.expectedDigest, 'artifact-integrity', 'Collected bytes differ from the authenticated collector digest/length');
    const preserved = this.redactor.artifact(raw, submission.artifact.mediaType), digest = sha256(preserved);
    requireEvidence(preserved.length <= this.limits.maxArtifactBytes, 'artifact-limit', 'Redacted artifact exceeds preservation limit');
    const locator = `artifacts/${digest}.blob`;
    const receipt = evidenceSchema.parse({
      schemaVersion: 1, evidenceId: submission.evidenceId, runId: grant.runId, taskId: grant.taskId, attemptId: grant.attemptId,
      kind: submission.kind, classification: submission.classification, digest, locator, mediaType: submission.artifact.mediaType, byteLength: preserved.length,
      summary: this.redactor.text(submission.summary), redacted: true,
      provenance: { collectorId: grant.collectorId, trust: 'collector', method: this.redactor.text(submission.method), collectedAt: submission.collectedAt,
        tool: { name: grant.tool.name, version: grant.tool.version, options: submission.toolOptions.map(v => this.redactor.text(v)) },
        environmentId: grant.environmentId, configurationDigest: grant.configurationDigest, inputDigests: grant.inputDigests,
        originalEnvironment: submission.originalEnvironment, modifications: submission.modifications.map(v => this.redactor.text(v)) },
      ...(submission.test ? { test: this.redactor.json(submission.test) } : {}),
      ...(submission.artifactIdentity ? { artifact: submission.artifactIdentity } : {}),
      ...(submission.deployment ? { deployment: submission.deployment } : {}),
      ...(submission.analysis ? { analysis: this.redactor.json(submission.analysis) } : {}),
      ...(submission.metadata ? { metadata: this.redactor.json(submission.metadata) } : {}),
    });
    const record: AdmissionRecord = {
      version: 1, keyDigest, admissionDigest, admittedAt: now, receipt, originalDigest: sha256(raw), originalBytes: raw.length, redactionPolicyDigest: this.redactor.policyDigest,
      collector: { identity: grant.collectorId, role: grant.role, grantDigest: digestJson(grant), toolImplementationDigest: grant.tool.implementationDigest, operationInputDigest: submission.operationInputDigest, scopeDigest: grant.scopeDigest, authorizationDigest: digestJson(grant.authorizationRef), validFrom: grant.validFrom, expiresAt: grant.expiresAt },
      limits: { ...this.limits },
    };
    // Validate and reserve all budgets before writing. Orphans after a failed commit never become receipts.
    requireEvidence(Buffer.byteLength(canonicalJson({ body: record, seal: this.seal(record) })) <= this.limits.maxReceiptBytes, 'receipt-limit', 'Receipt exceeds bounded integrity storage');
    const total = this.assertBudget(), artifactExists = existsSync(join(this.root, locator));
    requireEvidence(total + (artifactExists ? 0 : preserved.length) <= this.limits.maxTotalBytes, 'vault-limit', 'Vault byte budget exhausted');
    if (artifactExists) this.artifactBytes(receipt); else writeExclusive(join(this.root, locator), preserved);
    this.writeSigned(`records/${keyDigest}.json`, record);
    this.records.set(keyDigest, freeze(record)); this.receiptKeys.set(receipt.evidenceId, keyDigest);
    return freeze({ status: 'accepted', receipt: record.receipt, duplicate: false });
  }
  tryAdmit(handle: CollectorHandle, input: EvidenceSubmission): EvidenceAdmissionOutcome {
    try { return this.admit(handle, input); }
    catch (e) { return freeze({ status: 'rejected', code: e instanceof EvidenceError ? e.code : 'invalid-evidence', reason: e instanceof EvidenceError ? e.message : 'Evidence did not pass strict validation/redaction' }); }
  }
  get(evidenceId: string): EvidenceReceipt | undefined {
    this.active(); checkId(evidenceId);
    const key = this.receiptKeys.get(evidenceId);
    if (!key) return undefined;
    const disk = this.parseRecord(this.readSigned(`records/${key}.json`));
    requireEvidence(canonicalJson(disk) === canonicalJson(this.records.get(key)), 'vault-integrity', 'Immutable admission record changed');
    this.artifactBytes(disk.receipt);
    return freeze(disk.receipt);
  }
  inspect(evidenceId: string): Readonly<AdmissionRecord> | undefined {
    const receipt = this.get(evidenceId);
    if (!receipt) return undefined;
    return this.records.get(this.receiptKeys.get(evidenceId)!)!;
  }
  list(runId: string): EvidenceReceipt[] {
    checkId(runId); this.active();
    return [...this.receiptKeys.keys()].sort().map(id => this.get(id)!).filter(e => e.runId === runId);
  }
  read(evidenceId: string): Buffer {
    const receipt = this.get(evidenceId);
    requireEvidence(receipt, 'missing-evidence', 'No admitted artifact exists for this evidence identity');
    return this.artifactBytes(receipt);
  }
  close(): void {
    if (this.closed) return;
    this.active(); this.closed = true;
    this.key.fill(0); unlinkSync(join(this.root, '.writer')); syncDirectory(this.root);
  }
}
export function openEvidenceVault(options: EvidenceVaultOptions): EvidenceVault { return new EvidenceVault(options); }

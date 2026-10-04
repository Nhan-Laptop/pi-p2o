import { randomUUID } from 'node:crypto';
import { checkCancelled, invariant, PolicyError } from './errors.js';
import { deepFreeze, digest, identifier, integer, list, record, text } from './validation.js';
import type { CapabilityGrant, TargetLimits, WebTarget } from './types.js';

export interface BudgetSnapshot { requests: number; bytes: number; active: number; windowRequests: number }
export interface Reservation { consumeBytes(bytes: number): void; release(): void }
interface Counter { requests: number; bytes: number; active: number; timestamps: number[]; lastNow: number }
export interface BudgetState {
  version: 1;
  runId: string;
  limitsDigest: string;
  targets: Record<string, Counter>;
  grantCalls: Record<string, number>;
  artifactBytes: Record<string, number>;
}
/** Trusted, synchronous, transactional persistence behind a single supervisor writer fence. */
export interface BudgetJournal { load(runId: string): unknown; save(state: Readonly<BudgetState>): void }
export interface BudgetOptions { now?: () => number; runId?: string; journal?: BudgetJournal; freshRun?: boolean }

/** One supervisor-owned instance per run. Atomic local admission; not a distributed rate limiter. */
export class TargetBudget {
  private readonly counters = new Map<string, Counter>();
  private readonly limits = new Map<string, TargetLimits>();
  private readonly grantCalls = new Map<string, number>();
  private readonly artifacts = new Map<string, number>();
  private readonly now: () => number;
  private readonly journal?: BudgetJournal;
  private boundRunId?: string;
  private poisoned = false;
  readonly durable: boolean;
  constructor(targets: readonly WebTarget[], options: BudgetOptions = {}) {
    this.now = options.now ?? Date.now;
    this.journal = options.journal;
    this.durable = !!options.journal;
    if (options.runId) this.boundRunId = identifier(options.runId, 'budget.runId');
    for (const target of targets) {
      identifier(target.id, 'budget.targetId');
      invariant(!this.limits.has(target.id), 'INVALID_INPUT', 'Duplicate budget target');
      const limits = target.limits;
      integer(limits.maxRequests, 'maxRequests'); integer(limits.maxBytes, 'maxBytes'); integer(limits.maxConcurrent, 'maxConcurrent', 1, 128);
      integer(limits.rate.requests, 'rate.requests', 1, 4096); integer(limits.rate.windowMs, 'rate.windowMs', 1, 86400000);
      this.limits.set(target.id, deepFreeze(structuredClone(limits)));
      this.counters.set(target.id, { requests: 0, bytes: 0, active: 0, timestamps: [], lastNow: 0 });
    }
    if (this.journal) {
      invariant(this.boundRunId, 'INVALID_INPUT', 'Durable budgets require explicit run identity');
      let prior: unknown;
      try { prior = this.journal.load(this.boundRunId); } catch { throw new PolicyError('UNAVAILABLE', 'Durable budget state could not be loaded'); }
      if (prior !== undefined && prior !== null) {
        invariant(options.freshRun !== true, 'UNAVAILABLE', 'Run budget already exists; refusing to reset it');
        this.restore(prior);
      } else {
        invariant(options.freshRun === true, 'UNAVAILABLE', 'Missing restart budget state; explicit fresh-run admission required');
        this.persist();
      }
    }
  }
  /** Prevent accidental per-tool/foreign-run counters or a looser budget configuration. */
  bindRun(runId: string, targets: readonly WebTarget[]): void {
    identifier(runId, 'runId');
    invariant(!this.boundRunId || this.boundRunId === runId, 'IDENTITY_DENIED', 'Budget belongs to a different run');
    for (const target of targets) {
      const l = this.limits.get(target.id), s = target.limits;
      invariant(l && l.maxRequests <= s.maxRequests && l.maxBytes <= s.maxBytes && l.maxConcurrent <= s.maxConcurrent && l.rate.requests <= s.rate.requests && l.rate.windowMs >= s.rate.windowMs, 'BUDGET_EXCEEDED', 'Budget is absent or wider than approved target limits');
    }
    this.boundRunId = runId;
  }
  private assertHealthy(): void { invariant(!this.poisoned, 'UNAVAILABLE', 'Budget journal failed; further dispatch is denied'); }
  private persist(): void {
    if (!this.journal) return;
    try { const result: unknown = this.journal.save(this.exportState()); invariant(!(result && typeof (result as Promise<unknown>).then === 'function'), 'UNAVAILABLE', 'Budget journal must commit synchronously'); }
    catch { this.poisoned = true; throw new PolicyError('UNAVAILABLE', 'Budget persistence failed; no traffic may be dispatched'); }
  }
  exportState(): Readonly<BudgetState> {
    invariant(this.boundRunId, 'UNAVAILABLE', 'Budget has no run identity');
    return deepFreeze({ version: 1, runId: this.boundRunId, limitsDigest: digest(Object.fromEntries(this.limits)), targets: structuredClone(Object.fromEntries(this.counters)), grantCalls: Object.fromEntries(this.grantCalls), artifactBytes: Object.fromEntries(this.artifacts) });
  }
  private restore(value: unknown): void {
    const o = record(value, 'budget state', ['version', 'runId', 'limitsDigest', 'targets', 'grantCalls', 'artifactBytes']);
    invariant(o.version === 1 && o.runId === this.boundRunId && o.limitsDigest === digest(Object.fromEntries(this.limits)), 'UNAVAILABLE', 'Budget run/limits identity mismatch');
    const targets = record(o.targets, 'budget.targets');
    invariant(Object.keys(targets).length === this.limits.size, 'UNAVAILABLE', 'Budget target set changed');
    for (const [id, limits] of this.limits) {
      const c = record(targets[id], 'counter', ['requests', 'bytes', 'active', 'timestamps', 'lastNow']);
      const counter = { requests: integer(c.requests, 'requests', 0), bytes: integer(c.bytes, 'bytes', 0), active: integer(c.active, 'active', 0, limits.maxConcurrent), timestamps: list(c.timestamps, 'timestamps', (v, l) => integer(v, l, 0), 0, 4096), lastNow: integer(c.lastNow, 'lastNow', 0) };
      invariant(counter.requests >= counter.active && counter.timestamps.length <= counter.requests && counter.timestamps.every((v, i, a) => v <= counter.lastNow && (i === 0 || v >= a[i - 1]!)), 'UNAVAILABLE', 'Invalid restored budget counters');
      this.counters.set(id, counter);
    }
    for (const [field, map] of [['grantCalls', this.grantCalls], ['artifactBytes', this.artifacts]] as const) {
      const values = record(o[field], field);
      invariant(Object.keys(values).length <= 4096, 'OUTPUT_LIMIT', 'Excessive grant journal state');
      for (const [id, value] of Object.entries(values)) map.set(identifier(id, 'grantId'), integer(value, field, 0));
    }
  }
  /** Call only after runtime reconciliation has independently proved old execution terminated. */
  clearActiveAfterReconciliation(targetId: string, proof: { terminationVerified: true; reference: string }): void {
    this.assertHealthy(); invariant(proof.terminationVerified === true, 'UNAVAILABLE', 'Termination proof is required'); text(proof.reference, 'reconciliation reference');
    const c = this.counters.get(targetId); invariant(c, 'TARGET_DENIED', 'Unknown target'); c.active = 0; this.persist();
  }
  chargeCall(grant: Readonly<CapabilityGrant>): void {
    this.assertHealthy();
    const count = this.grantCalls.get(grant.id) ?? 0;
    invariant(count < grant.maxCalls, 'BUDGET_EXCEEDED', 'Capability call budget exhausted');
    this.grantCalls.set(grant.id, count + 1); this.persist();
  }
  chargeArtifact(grant: Readonly<CapabilityGrant>, bytes: number): void {
    this.assertHealthy(); integer(bytes, 'artifact bytes', 0);
    const next = (this.artifacts.get(grant.id) ?? 0) + bytes;
    invariant(next <= grant.maxArtifactBytes, 'BUDGET_EXCEEDED', 'Capability artifact budget exhausted');
    this.artifacts.set(grant.id, next); this.persist();
  }
  reserve(targetId: string): Reservation {
    this.assertHealthy();
    const c = this.counters.get(targetId), limits = this.limits.get(targetId);
    invariant(c && limits, 'TARGET_DENIED', 'No budget for target');
    const time = Math.max(c.lastNow, this.now());
    invariant(Number.isSafeInteger(time) && time >= 0, 'UNAVAILABLE', 'Budget clock unavailable');
    c.lastNow = time; c.timestamps = c.timestamps.filter(t => time - t < limits.rate.windowMs);
    invariant(c.requests < limits.maxRequests && c.bytes < limits.maxBytes && c.active < limits.maxConcurrent, 'BUDGET_EXCEEDED', 'Target request/byte/concurrency budget exhausted');
    invariant(c.timestamps.length < limits.rate.requests, 'RATE_LIMITED', 'Target-wide rate limit exceeded');
    c.requests += 1; c.active += 1; c.timestamps.push(time); this.persist();
    let released = false;
    const persist = () => this.persist(), healthy = () => this.assertHealthy();
    return Object.freeze({
      consumeBytes(bytes: number) {
        healthy(); invariant(!released, 'INVALID_INPUT', 'Reservation already released'); integer(bytes, 'traffic bytes', 0);
        c.bytes += bytes; persist(); // failed traffic stays charged; no retry refunds
        invariant(c.bytes <= limits.maxBytes, 'BUDGET_EXCEEDED', 'Target byte budget exhausted');
      },
      release() { if (!released) { released = true; c.active -= 1; persist(); } },
    });
  }
  snapshot(targetId: string): Readonly<BudgetSnapshot> {
    const c = this.counters.get(targetId), limits = this.limits.get(targetId);
    invariant(c && limits, 'TARGET_DENIED', 'Unknown budget target');
    const time = Math.max(c.lastNow, this.now());
    return Object.freeze({ requests: c.requests, bytes: c.bytes, active: c.active, windowRequests: c.timestamps.filter(t => time - t < limits.rate.windowMs).length });
  }
  grantSnapshot(grantId: string): Readonly<{ calls: number; artifactBytes: number }> {
    return Object.freeze({ calls: this.grantCalls.get(grantId) ?? 0, artifactBytes: this.artifacts.get(grantId) ?? 0 });
  }
}

// ---------------------------------------------------------------------------------------------
// Model spend ledger: pre-request reservation against the run's token/cost budget, settlement with
// provider-observed usage, durable and idempotent across restarts.

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelThinking = typeof THINKING_LEVELS[number];
export interface ModelSpendLimits { maxTokens: number; maxCostUsd: number }
export interface ModelSpendSelection { provider: string; model: string; thinking: ModelThinking }
export interface ModelPrice { inputMicroUsdPerMillion: number; outputMicroUsdPerMillion: number }
export type ModelPriceTable = Readonly<Record<string, Readonly<ModelPrice>>>;
const MODEL_SPEND_MAX_RECORDS = 20_000;

/** Build a frozen price table from USD-per-million-token quotes (1 USD = 1e6 micro-USD). */
export function pinnedModelPrices(entries: Readonly<Record<string, { input: number; output: number }>>): ModelPriceTable {
  invariant(Object.keys(entries).length <= 256, 'OUTPUT_LIMIT', 'Excessive model price catalog');
  const table: Record<string, Readonly<ModelPrice>> = {};
  for (const [key, quote] of Object.entries(entries)) {
    text(key, 'price key', 192);
    const input = quote?.input, output = quote?.output;
    invariant(typeof input === 'number' && Number.isFinite(input) && input >= 0 && input <= 1_000_000 && typeof output === 'number' && Number.isFinite(output) && output >= 0 && output <= 1_000_000, 'INVALID_INPUT', 'Model prices must be bounded non-negative USD per million tokens');
    table[key] = deepFreeze({ inputMicroUsdPerMillion: Math.ceil(input * 1_000_000), outputMicroUsdPerMillion: Math.ceil(output * 1_000_000) });
  }
  return deepFreeze(table);
}

/**
 * Pinned per-model price catalog. The `fixture-*`/`inert-*` quotes are synthetic fixture quotes, not live
 * market data. The live entry is the owner-pinned public list price for the one live selection this
 * repository may dispatch, and an unpriced selection fails closed in `reserve`, so a missing price can
 * never be silently charged as zero.
 *
 * `deepseek/deepseek-flash` (DeepSeek-V4.1-Flash, GA 2026-09-10) hourly PEAK rate, cache-miss input and
 * output, quoted on the vendor's public pricing page as $0.30 / $1.20 per 1M tokens
 * (https://api-docs.deepseek.com/quick_start/pricing: "1M INPUT TOKENS (CACHE MISS) PEAK $0.3",
 * "1M OUTPUT TOKENS PEAK $1.2"; off-peak is exactly half of peak). The peak rate is pinned deliberately:
 * a live run must never be bounded by the cheaper off-peak window.
 */
export const PINNED_MODEL_PRICES: ModelPriceTable = pinnedModelPrices({
  'fixture-provider/fixture-model': { input: 3, output: 15 },
  'inert-fixture/inert-worker': { input: 3, output: 15 },
  'openai-completions/p2o-inert-1': { input: 0, output: 0 },
  'deepseek/deepseek-flash': { input: 0.3, output: 1.2 },
});

export const modelPriceKey = (provider: string, model: string): string => `${provider}/${model}`;
const microUsdForTokens = (tokens: number, microUsdPerMillion: number): number => Math.ceil((tokens * microUsdPerMillion) / 1_000_000);
const usdToMicros = (value: number): number => Math.ceil(value * 1_000_000);
const usdLimitToMicros = (value: number): number => Math.floor(value * 1_000_000);
const microsToUsd = (micros: number): number => micros / 1_000_000;
function money(value: unknown, label: string): number {
  invariant(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000, 'INVALID_INPUT', `${label} must be a bounded non-negative USD amount`);
  return value;
}
function sameSelection(a: ModelSpendSelection, b: ModelSpendSelection): boolean {
  return a.provider === b.provider && a.model === b.model && a.thinking === b.thinking;
}
/** [T9] A charge recorded because no usage could be read, with the explicit reason folded into the basis. */
function assumedBasis(reason: string): string {
  const clean = text(reason, 'unobserved reason', 64).replace(/[^a-zA-Z0-9._:-]+/g, '-');
  return text(`${MODEL_SPEND_BASIS.assumedWorstCase}:${clean}`, 'charge basis', 64);
}
function storedSelection(value: unknown): ModelSpendSelection {
  const o = record(value, 'selection', ['provider', 'model', 'thinking']);
  const provider = text(o.provider, 'selection.provider', 128);
  const model = text(o.model, 'selection.model', 192);
  const thinking = o.thinking;
  invariant(typeof thinking === 'string' && THINKING_LEVELS.includes(thinking as ModelThinking), 'INVALID_INPUT', 'Unsupported thinking level');
  return deepFreeze({ provider, model, thinking: thinking as ModelThinking });
}

/**
 * [T11] A catch-up observation that arrived while admitted provider turns were still in flight. R4 §4 (W4)
 * showed the pre-T11 ledger charging such an observation in full and then charging the same usage again when
 * those turns settled (2 800 committed against a 2 000 limit, `overshoot 0`). The observation is kept durably
 * on the hold, charges nothing while any turn is open, and is applied by the next catch-up or by `release`.
 */
export interface ModelSpendDeferredCatchUp {
  /** Cumulative observed usage for the attempt at the time it was deferred (tokens, not a delta). */
  inputTokens: number;
  outputTokens: number;
  reportedCostMicros: number | null;
  basis: string;
  /** In-flight turns at that moment: the reason the observation could not be charged yet. */
  openTurns: number;
  deferredAt: number;
}
/**
 * [T10] One attempt's durable hold. `reservedTokens`/`reservedCostMicros` are what is still held for the
 * attempt; the counters below are what makes concurrent admission sound: every admitted provider turn mints a
 * monotonic identity here (never from the settled-charge count), and its worst-case bound stays reserved for as
 * long as the turn is in flight (`openTurns`/`openTokens`/`openCostMicros`).
 *
 * [T11] `deferred`/`deferredCatchUps` are the durable evidence of an observation held back because turns were
 * in flight; they never charge anything by themselves.
 */
export interface ModelSpendActiveReservation {
  attemptId: string;
  selection: ModelSpendSelection;
  reservedTokens: number;
  reservedCostMicros: number;
  createdAt: number;
  /** [T10] Highest provider-turn number admitted against this hold (0 before the first admission). */
  admittedTurns: number;
  /** [T10] Number of catch-up (observed) charges written for this hold. */
  observedCharges: number;
  /** [T10] Admitted turns that have not been charged yet. */
  openTurns: number;
  /** [T10] Sum of the worst-case bounds of the turns still in flight. */
  openTokens: number;
  openCostMicros: number;
  /** Exact outstanding turn bounds for crash/unknown-usage settlement; absent only in legacy journals. */
  turnHolds?: Record<string, { inputTokens: number; outputTokens: number }>;
  /** Terminal proof seals admission even while paid outstanding turns remain reconcilable. */
  terminalReconciled?: true;
  /** [T11] How many catch-up observations were deferred while turns were in flight (durable evidence). */
  deferredCatchUps?: number;
  /** [T11] Latest deferred observation, applied by the next catch-up or by the hold's release. */
  deferred?: ModelSpendDeferredCatchUp;
}
export interface ModelSpendSettlementRecord { attemptId: string; selection: ModelSpendSelection; inputTokens: number; outputTokens: number; tokens: number; costMicros: number; reportedCostMicros: number | null; overshootTokens: number; overshootCostMicros: number; settledAt: number; /** [T9] Charge basis; absent on records persisted before per-turn charging (read as observed usage). */ basis?: string }
export interface ModelSpendReleaseRecord { attemptId: string; reason: string; releasedAt: number; admittedTurns?: number }

/** Durable, synchronous persistence of the run's model spend ledger behind the supervisor writer fence. */
export interface ModelSpendState {
  version: 1;
  runId: string;
  priceDigest: string;
  limitsDigest: string;
  limits: { maxTokens: number; maxCostUsdMicros: number };
  reservations: Record<string, ModelSpendActiveReservation>;
  settlements: Record<string, ModelSpendSettlementRecord>;
  released: Record<string, ModelSpendReleaseRecord>;
  committed: { tokens: number; costMicros: number };
  overshoot: { tokens: number; costMicros: number };
}
export interface ModelSpendJournal {
  load(runId: string): unknown;
  save(state: Readonly<ModelSpendState>): void;
  /** Optional trusted check that the attempt belongs to the run, backed by store execution identity. */
  ownsAttempt?(runId: string, attemptId: string): boolean;
}
export interface ModelSpendOptions { now?: () => number; runId?: string; journal?: ModelSpendJournal; freshRun?: boolean; prices?: ModelPriceTable; maxTurns?: number; selection?: ModelSpendSelection; admissionGuard?: () => void }

export interface ModelSpendRequest {
  attemptId: string;
  selection: ModelSpendSelection;
  /** Upper bound on tokens the request will send; part of the worst-case reservation. */
  inputTokensUpperBound: number;
  /** Upper bound declared for the completion; part of the worst-case reservation. */
  maxOutputTokens: number;
  reservationId?: string;
}
/** Legacy normalized usage (fixture receipts and existing callers). */
export interface ModelSpendUsage { inputTokens: number; outputTokens: number; reportedCostUsd?: number }
/**
 * [T8] The provider-reported assistant usage the real Pi 1.0.0 worker emits (`pi-ai` Usage):
 * `usage.input`/`usage.output` plus `usage.cost.total`. The settlement adapter accepts this shape
 * directly so a real worker's receipt settles the ledger; a present-but-unparseable usage fails
 * explicitly (`INVALID_INPUT`) instead of ever being charged as zero.
 */
export interface ProviderModelSpendUsage {
  input: number;
  output: number;
  cost?: { total: number };
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
}
export type ModelSpendUsageInput = ModelSpendUsage | ProviderModelSpendUsage;
export interface ModelSpendSettlementInput { reservationId: string; attemptId: string; selection: ModelSpendSelection; usage: ModelSpendUsageInput }
/** [T9] Canonical charge bases recorded on every per-turn/observed settlement record. */
export const MODEL_SPEND_BASIS = Object.freeze({
  providerUsage: 'provider-usage',
  assumedWorstCase: 'assumed-worst-case',
  sessionCatchUp: 'session-catch-up',
});

/** [T9] One provider request admitted against the attempt's hold; the controller derives every bound here. */
export interface ModelSpendTurnRequest {
  /** The attempt's active reservation (the launch envelope). A turn is only admitted while it is held. */
  reservationId: string;
  attemptId: string;
  selection: ModelSpendSelection;
  /** Controller-derived upper bound on the tokens this request will send (request payload bytes). */
  inputTokensUpperBound: number;
  /** Supervisor-declared completion bound for this turn; never a worker-supplied number. */
  maxOutputTokens: number;
}
/** [T9] What charging one admitted turn produced. `assumed` marks an explicit worst-case charge. */
export interface ModelSpendTurnCharge {
  turnId: string;
  turn: number;
  attemptId: string;
  selection: ModelSpendSelection;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costUsd: number;
  /** Exact integer micro-USD charged, for callers that must not round-trip through a float. */
  costMicros: number;
  reportedCostUsd?: number;
  overshoot: { tokens: number; costUsd: number };
  /** Charge basis: observed provider usage, an explicit worst-case assumption, or a session catch-up. */
  basis: string;
  assumed: boolean;
  duplicate: boolean;
  settledAt: number;
  snapshot: Readonly<ModelSpendSnapshot>;
}
/** [T9] The permit one admitted turn returns; charging is idempotent by `turnId`. */
export interface ModelSpendTurn {
  readonly turnId: string;
  readonly turn: number;
  readonly attemptId: string;
  readonly selection: ModelSpendSelection;
  readonly reservedTokens: number;
  readonly reservedCostUsd: number;
  /** Charge the usage the provider reported for this turn. */
  charge(usage: ModelSpendUsageInput): Readonly<ModelSpendTurnCharge>;
  /** No usage could be read: charge the admitted worst case and record an explicit reason, never skip the turn. */
  chargeUnobserved(reason: string): Readonly<ModelSpendTurnCharge>;
}
/** [T9] Cumulative usage already charged against one attempt reservation. */
export interface ModelSpendAttemptUsage {
  turns: number;
  catchUps: number;
  assumedTurns: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costUsd: number;
}
/** [T9] Session/receipt catch-up: charge only the observed usage not yet charged for this attempt. */
export interface ModelSpendCatchUpRequest {
  reservationId: string;
  attemptId: string;
  selection: ModelSpendSelection;
  usage: ModelSpendUsageInput;
  basis?: string;
}
export interface ModelSpendSnapshot {
  runId: string;
  limits: { maxTokens: number; maxCostUsd: number };
  committed: { tokens: number; costUsd: number };
  /** USD charged from pinned cache-miss prices is conservative policy accounting, not a provider invoice. */
  costPolicy: 'pinned-cache-miss-price';
  observedCostUsd: number | null;
  accountedCostUsd: number;
  active: { count: number; tokens: number; costUsd: number };
  remaining: { tokens: number; costUsd: number };
  overshoot: { tokens: number; costUsd: number };
  /** [T11] Settled spend above the run's own pinned limit — a genuine run-limit breach, always visible. */
  breach: { tokens: number; costUsd: number };
  /**
   * [T11] Observations held back because turns were in flight (never dropped, never double-charged):
   * `tokens` is what was deferred, `claimedTokens`/`claimedCostUsd` is the part admission still counts as
   * spent (the delta beyond what the attempt paid and what its in-flight turns hold).
   */
  deferred: { holds: number; tokens: number; claimedTokens: number; claimedCostUsd: number };
  settlements: number;
  released: number;
}
export interface ModelSpendSettlement {
  reservationId: string;
  attemptId: string;
  selection: ModelSpendSelection;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costUsd: number;
  reportedCostUsd?: number;
  overshoot: { tokens: number; costUsd: number };
  duplicate: boolean;
  settledAt: number;
  snapshot: Readonly<ModelSpendSnapshot>;
}
export interface ModelSpendReservation {
  readonly reservationId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly selection: Readonly<ModelSpendSelection>;
  readonly reservedTokens: number;
  readonly reservedCostUsd: number;
  settle(usage: ModelSpendUsageInput): Readonly<ModelSpendSettlement>;
  release(reason?: string): void;
}

/** One supervisor-owned instance per run; worst-case admission before dispatch, exact settlement after. */
export class ModelSpendBudget {
  private readonly prices: ModelPriceTable;
  private readonly priceDigest: string;
  private readonly maxTurns?: number;
  private readonly selectionPin?: ModelSpendSelection;
  private readonly admissionGuard?: () => void;
  private readonly limits: Readonly<{ maxTokens: number; maxCostUsdMicros: number }>;
  private readonly limitsDigest: string;
  private readonly reservations = new Map<string, ModelSpendActiveReservation>();
  private readonly settlements = new Map<string, ModelSpendSettlementRecord>();
  private readonly released = new Map<string, ModelSpendReleaseRecord>();
  private committed = { tokens: 0, costMicros: 0 };
  private overshootTotals = { tokens: 0, costMicros: 0 };
  private activeTokens = 0;
  private activeCostMicros = 0;
  /**
   * [T11] Provider turns admitted by *this* ledger instance and not charged yet, with the worst-case bound each
   * still holds. In memory on purpose: it never enters the journal. The durable `openTurns`/`openTokens`
   * counters count every admission (including one from a process that crashed), but only a turn admitted here
   * can still charge this ledger, so only it justifies deferring a catch-up.
   */
  private readonly liveTurns = new Map<string, { turns: number; tokens: number; costMicros: number }>();
  /**
   * [T12] The exact state of the last successful commit, plus the in-flight coverage that state implies.
   * `persist()` restores both when a save fails, so the in-memory ledger can neither drift from the durable
   * journal nor wedge against it: the previous durable state survives, the failing operation still throws,
   * and the hold stays releasable/retryable. `undefined` only before the first commit of this instance.
   */
  private lastDurable?: { state: Readonly<ModelSpendState>; liveTurns: Map<string, { turns: number; tokens: number; costMicros: number }> };
  /**
   * [T12] Set when a commit fails. The ledger keeps reading the last durable state and refuses new
   * dispatch (and the supervisor-facing `snapshot()`) until a commit succeeds again — fail closed, but
   * never permanently wedged: the terminal release and every reconciliation charge are still allowed, and
   * any successful persist clears it. The pre-T12 sentinel was permanent: no operation could ever clear it.
   */
  private degraded = false;
  /** [T12] Holds whose charge could not be committed: releasing them would drop provider-paid usage. */
  private readonly unpersistedCharges = new Set<string>();
  private readonly now: () => number;
  private readonly journal?: ModelSpendJournal;
  private boundRunId?: string;
  readonly durable: boolean;

  constructor(limits: ModelSpendLimits, options: ModelSpendOptions = {}) {
    this.now = options.now ?? Date.now;
    this.admissionGuard = options.admissionGuard;
    this.journal = options.journal;
    this.durable = !!options.journal;
    this.prices = options.prices ?? PINNED_MODEL_PRICES;
    this.priceDigest = digest(this.prices);
    const maxTokens = integer(limits.maxTokens, 'maxTokens', 0);
    this.limits = Object.freeze({ maxTokens, maxCostUsdMicros: usdLimitToMicros(money(limits.maxCostUsd, 'maxCostUsd')) });
    this.maxTurns = options.maxTurns === undefined ? undefined : integer(options.maxTurns, 'maxTurns', 1, MODEL_SPEND_MAX_RECORDS - 1);
    this.selectionPin = options.selection === undefined ? undefined : storedSelection(options.selection);
    this.limitsDigest = digest({ ...this.limits, ...(this.maxTurns === undefined ? {} : { maxTurns: this.maxTurns }), ...(this.selectionPin === undefined ? {} : { selection: this.selectionPin }) });
    if (options.runId) this.boundRunId = identifier(options.runId, 'modelSpend.runId');
    if (this.journal) {
      invariant(this.boundRunId, 'INVALID_INPUT', 'Durable model spend ledgers require explicit run identity');
      let prior: unknown;
      try { prior = this.journal.load(this.boundRunId); } catch { throw new PolicyError('UNAVAILABLE', 'Durable model spend state could not be loaded'); }
      if (prior !== undefined && prior !== null) {
        invariant(options.freshRun !== true, 'UNAVAILABLE', 'Run model spend ledger already exists; refusing to reset it');
        this.restore(prior);
        this.captureBaseline();
      } else {
        invariant(options.freshRun === true, 'UNAVAILABLE', 'Missing restart model spend state; explicit fresh-run admission required');
        this.persist();
      }
    }
  }

  /** Prevent foreign-run counters or a pinned limit configuration wider than the approved run budget. */
  bindRun(runId: string, limits: ModelSpendLimits): void {
    identifier(runId, 'runId');
    invariant(!this.boundRunId || this.boundRunId === runId, 'IDENTITY_DENIED', 'Model spend ledger belongs to a different run');
    const approvedTokens = integer(limits.maxTokens, 'maxTokens', 0);
    const approvedCostMicros = usdLimitToMicros(money(limits.maxCostUsd, 'maxCostUsd'));
    invariant(this.limits.maxTokens <= approvedTokens && this.limits.maxCostUsdMicros <= approvedCostMicros, 'BUDGET_EXCEEDED', 'Model spend limits are absent or wider than the approved run budget');
    this.boundRunId = runId;
  }

  /**
   * [T12] A corrupt journal is refused at `restore()`; a failed *write* never wedges the ledger. `persist()`
   * rolls the in-memory state back to the last commit and only the failing operation throws, so the hold
   * stays releasable, `snapshot()` keeps reading the last durable state, and every later operation retries
   * against real durable state. While a commit is outstanding the ledger is *degraded*: new dispatch and
   * `snapshot()` are refused (a failed charge must not be spent as if it were durable), while the terminal
   * release and reconciliation charges still run and clear the state on their first successful commit.
   */
  private assertHealthy(): void { invariant(!this.degraded, 'UNAVAILABLE', 'Model spend journal failed; further dispatch is denied'); }
  private requireRun(): string { invariant(this.boundRunId, 'UNAVAILABLE', 'Model spend ledger has no run identity'); return this.boundRunId; }
  private parseSelection(value: unknown): ModelSpendSelection {
    const o = record(value, 'model selection', ['provider', 'model', 'thinking']);
    const provider = text(o.provider, 'selection.provider', 128);
    const model = text(o.model, 'selection.model', 192);
    const thinking = o.thinking;
    invariant(typeof thinking === 'string' && THINKING_LEVELS.includes(thinking as ModelThinking), 'INVALID_INPUT', 'Unsupported thinking level');
    invariant(!this.selectionPin || sameSelection(this.selectionPin, { provider, model, thinking: thinking as ModelThinking }), 'IDENTITY_DENIED', 'Model selection differs from owner phase allocation');
    return deepFreeze({ provider, model, thinking: thinking as ModelThinking });
  }
  private priceFor(selection: ModelSpendSelection): Readonly<ModelPrice> {
    const price = this.prices[modelPriceKey(selection.provider, selection.model)];
    invariant(price, 'BUDGET_EXCEEDED', 'No pinned price for the requested provider/model; the request cannot be bounded');
    return price;
  }
  private assertAttempt(runId: string, attemptId: string): void {
    const owns = this.journal?.ownsAttempt;
    if (!owns) return;
    let owned = false;
    try { owned = owns.call(this.journal, runId, attemptId); } catch { throw new PolicyError('UNAVAILABLE', 'Model spend execution identity could not be verified'); }
    invariant(owned, 'IDENTITY_DENIED', 'Model spend attempt does not belong to this run');
  }
  /**
   * [T8] Parse either the legacy normalized usage or the real provider-reported assistant usage
   * (`usage.input`/`usage.output`/`usage.cost.total`). Both shapes are validated strictly and unknown
   * fields are refused, so a malformed receipt fails the settlement instead of charging zero.
   */
  private parseUsage(value: unknown): { inputTokens: number; outputTokens: number; reportedCostMicros: number | null } {
    const raw = record(value, 'model spend usage', ['inputTokens', 'outputTokens', 'reportedCostUsd', 'input', 'output', 'cost', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens']);
    if ('input' in raw || 'output' in raw || 'cost' in raw) {
      const o = record(raw, 'provider model spend usage', ['input', 'output', 'cost', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens']);
      const cost = o.cost === undefined ? undefined : record(o.cost, 'provider model spend cost', ['total']);
      const output = integer(o.output, 'usage.output', 0);
      if (o.reasoning !== undefined) invariant(integer(o.reasoning, 'usage.reasoning', 0) <= output, 'INVALID_INPUT', 'Reasoning usage must be an output subset');
      if (o.totalTokens !== undefined) integer(o.totalTokens, 'usage.totalTokens', 0);
      return {
        // Pi input is cache-miss input; cache counters are disjoint, reasoning is a subset of output.
        inputTokens: integer(o.input, 'usage.input', 0) + integer(o.cacheRead ?? 0, 'usage.cacheRead', 0) + integer(o.cacheWrite ?? 0, 'usage.cacheWrite', 0),
        outputTokens: integer(o.output, 'usage.output', 0),
        reportedCostMicros: cost === undefined ? null : usdToMicros(money(cost.total, 'usage.cost.total')),
      };
    }
    const o = record(raw, 'model spend usage', ['inputTokens', 'outputTokens', 'reportedCostUsd']);
    return { inputTokens: integer(o.inputTokens, 'inputTokens', 0), outputTokens: integer(o.outputTokens, 'outputTokens', 0), reportedCostMicros: o.reportedCostUsd === undefined ? null : usdToMicros(money(o.reportedCostUsd, 'reportedCostUsd')) };
  }
  private persist(): void {
    if (!this.journal) return;
    const state = this.exportState();
    try {
      const result: unknown = this.journal.save(state);
      invariant(!(result && typeof (result as Promise<unknown>).then === 'function'), 'UNAVAILABLE', 'Model spend journal must commit synchronously');
    } catch {
      // [T12] The store's own transaction rolls back, so the previous durable state survives; drop the
      // in-memory mutation that could not be committed, fail this operation loudly, and stay usable.
      this.rollback();
      this.degraded = true;
      throw new PolicyError('UNAVAILABLE', 'Model spend persistence failed; no model request may be dispatched');
    }
    this.degraded = false;
    this.captureBaseline(state);
  }

  /** [T12] Remember the state a successful `save()` committed, plus the in-flight coverage it implies. */
  private captureBaseline(state: Readonly<ModelSpendState> = this.exportState()): void {
    this.lastDurable = { state: deepFreeze(structuredClone(state)), liveTurns: new Map([...this.liveTurns].map(([id, live]) => [id, { ...live }])) };
  }

  /** [T12] Restore the last committed state after a failed save (a no-op before this instance's first commit). */
  private rollback(): void {
    const last = this.lastDurable;
    if (!last) return;
    this.reservations.clear(); this.settlements.clear(); this.released.clear();
    this.committed = { tokens: 0, costMicros: 0 };
    this.overshootTotals = { tokens: 0, costMicros: 0 };
    this.activeTokens = 0; this.activeCostMicros = 0;
    this.liveTurns.clear();
    for (const [id, live] of last.liveTurns) this.liveTurns.set(id, { ...live });
    this.restore(last.state);
  }

  exportState(): Readonly<ModelSpendState> {
    const runId = this.requireRun();
    return deepFreeze({
      version: 1,
      runId,
      priceDigest: this.priceDigest,
      limitsDigest: this.limitsDigest,
      limits: { maxTokens: this.limits.maxTokens, maxCostUsdMicros: this.limits.maxCostUsdMicros },
      // [T12] The real `DurableStore` journal writes through `canonicalJson`, which rejects any non-JSON
      // value: an own key whose value is `undefined` (`structuredClone` keeps it) failed every deferral
      // clear and every observed charge. Optional fields are therefore omitted, never persisted empty.
      reservations: Object.fromEntries([...this.reservations].map(([id, r]) => [id, this.durableReservation(r)])),
      settlements: Object.fromEntries([...this.settlements].map(([id, r]) => [id, structuredClone(r)])),
      released: Object.fromEntries([...this.released].map(([id, r]) => [id, structuredClone(r)])),
      committed: { ...this.committed },
      overshoot: { ...this.overshootTotals },
    });
  }

  /** [T12] One reservation exactly as it may be persisted: [T11] optionals appear only when they hold a value. */
  private durableReservation(r: ModelSpendActiveReservation): ModelSpendActiveReservation {
    return {
      attemptId: r.attemptId,
      selection: structuredClone(r.selection),
      reservedTokens: r.reservedTokens,
      reservedCostMicros: r.reservedCostMicros,
      createdAt: r.createdAt,
      admittedTurns: r.admittedTurns,
      observedCharges: r.observedCharges,
      openTurns: r.openTurns,
      openTokens: r.openTokens,
      openCostMicros: r.openCostMicros,
      ...(r.turnHolds === undefined ? {} : { turnHolds: structuredClone(r.turnHolds) }),
      ...(r.terminalReconciled === undefined ? {} : { terminalReconciled: r.terminalReconciled }),
      ...(r.deferredCatchUps === undefined ? {} : { deferredCatchUps: r.deferredCatchUps }),
      ...(r.deferred === undefined ? {} : { deferred: structuredClone(r.deferred) }),
    };
  }

  private restore(value: unknown): void {
    try {
      const o = record(value, 'model spend state', ['version', 'runId', 'priceDigest', 'limitsDigest', 'limits', 'reservations', 'settlements', 'released', 'committed', 'overshoot']);
      invariant(o.version === 1 && o.runId === this.boundRunId && o.priceDigest === this.priceDigest && o.limitsDigest === this.limitsDigest, 'UNAVAILABLE', 'Model spend run/prices/limits identity mismatch');
      const limits = record(o.limits, 'model spend limits', ['maxTokens', 'maxCostUsdMicros']);
      invariant(integer(limits.maxTokens, 'maxTokens', 0) === this.limits.maxTokens && integer(limits.maxCostUsdMicros, 'maxCostUsdMicros', 0) === this.limits.maxCostUsdMicros, 'UNAVAILABLE', 'Persisted model spend limits changed');
      const reservations = record(o.reservations, 'model spend reservations');
      invariant(Object.keys(reservations).length <= MODEL_SPEND_MAX_RECORDS, 'OUTPUT_LIMIT', 'Excessive model spend reservation state');
      // [T10] Counters are read as one set: a state written by the previous revision restores them from the
      // durable charge ids below, so a restarted ledger can never mint a turn identity that already exists.
      const restored = new Map<string, { countersDeclared: boolean; record: ModelSpendActiveReservation }>();
      for (const [id, raw] of Object.entries(reservations)) {
        identifier(id, 'reservationId');
        const r = record(raw, 'reservation', ['attemptId', 'selection', 'reservedTokens', 'reservedCostMicros', 'createdAt', 'admittedTurns', 'observedCharges', 'openTurns', 'openTokens', 'openCostMicros', 'deferredCatchUps', 'deferred', 'turnHolds', 'terminalReconciled']);
        invariant(r.terminalReconciled === undefined || r.terminalReconciled === true, 'UNAVAILABLE', 'Invalid terminal admission seal');
        const countersDeclared = r.admittedTurns !== undefined && r.observedCharges !== undefined && r.openTurns !== undefined && r.openTokens !== undefined && r.openCostMicros !== undefined;
        const reservedTokens = integer(r.reservedTokens, 'reservedTokens', 0), reservedCostMicros = integer(r.reservedCostMicros, 'reservedCostMicros', 0);
        const openTokens = countersDeclared ? integer(r.openTokens, 'openTokens', 0) : 0;
        invariant(reservedTokens >= openTokens, 'UNAVAILABLE', 'Persisted reservation is smaller than the turns it holds in flight');
        invariant(!countersDeclared || reservedCostMicros >= integer(r.openCostMicros, 'openCostMicros', 0), 'UNAVAILABLE', 'Persisted cost reservation is smaller than its in-flight turns');
        // [T11] A deferred catch-up is optional (a hold written before T11 never has one) and is validated like
        // the observation it came from, so a corrupted journal cannot turn it into an unbounded claim.
        let deferred: ModelSpendDeferredCatchUp | undefined;
        if (r.deferred !== undefined) {
          const d = record(r.deferred, 'deferred catch-up', ['inputTokens', 'outputTokens', 'reportedCostMicros', 'basis', 'openTurns', 'deferredAt']);
          deferred = deepFreeze({
            inputTokens: integer(d.inputTokens, 'deferred.inputTokens', 0),
            outputTokens: integer(d.outputTokens, 'deferred.outputTokens', 0),
            reportedCostMicros: d.reportedCostMicros === null ? null : integer(d.reportedCostMicros, 'deferred.reportedCostMicros', 0),
            basis: text(d.basis, 'deferred.basis', 64),
            openTurns: integer(d.openTurns, 'deferred.openTurns', 0),
            deferredAt: integer(d.deferredAt, 'deferred.deferredAt', 0),
          });
        }
        let turnHolds: ModelSpendActiveReservation['turnHolds'];
        if (r.turnHolds !== undefined) {
          turnHolds = {};
          let heldTokens = 0, heldMicros = 0;
          for (const [turnId, bound] of Object.entries(record(r.turnHolds, 'turnHolds'))) {
            invariant(turnId.startsWith(`${id}:turn-`) && /^\d+$/.test(turnId.slice(`${id}:turn-`.length)), 'UNAVAILABLE', 'Invalid turn hold identity');
            const turnNumber = Number(turnId.slice(`${id}:turn-`.length));
            invariant(Number.isSafeInteger(turnNumber) && turnNumber >= 1 && turnNumber <= integer(r.admittedTurns, 'admittedTurns', 0), 'UNAVAILABLE', 'Turn hold exceeds durable admission identity');
            const b = record(bound, 'turn bound', ['inputTokens', 'outputTokens']);
            const inputTokens = integer(b.inputTokens, 'held input', 0), outputTokens = integer(b.outputTokens, 'held output', 0);
            turnHolds[turnId] = { inputTokens, outputTokens };
            heldTokens += inputTokens + outputTokens;
            heldMicros += this.chargeCostMicros(storedSelection(r.selection), inputTokens, outputTokens);
          }
          invariant(heldTokens === openTokens && heldMicros === r.openCostMicros && Object.keys(turnHolds).length === r.openTurns, 'UNAVAILABLE', 'Turn bounds do not match durable open counters');
        }
        restored.set(id, { countersDeclared, record: {
          attemptId: identifier(r.attemptId, 'attemptId'), selection: storedSelection(r.selection), reservedTokens, reservedCostMicros,
          createdAt: integer(r.createdAt, 'createdAt', 0),
          admittedTurns: countersDeclared ? integer(r.admittedTurns, 'admittedTurns', 0) : 0,
          observedCharges: countersDeclared ? integer(r.observedCharges, 'observedCharges', 0) : 0,
          openTurns: countersDeclared ? integer(r.openTurns, 'openTurns', 0) : 0,
          openTokens,
          openCostMicros: countersDeclared ? integer(r.openCostMicros, 'openCostMicros', 0) : 0,
          ...(turnHolds === undefined ? {} : { turnHolds }),
          ...(r.terminalReconciled === true ? { terminalReconciled: true as const } : {}),
          ...(r.deferredCatchUps === undefined ? {} : { deferredCatchUps: integer(r.deferredCatchUps, 'deferredCatchUps', 0) }),
          ...(deferred === undefined ? {} : { deferred }),
        } });
      }
      const settlements = record(o.settlements, 'model spend settlements');
      invariant(Object.keys(settlements).length <= MODEL_SPEND_MAX_RECORDS, 'OUTPUT_LIMIT', 'Excessive model spend settlement state');
      for (const [id, raw] of Object.entries(settlements)) {
        identifier(id, 'settlementId');
        invariant(!restored.has(id), 'UNAVAILABLE', 'Model spend reservation is both active and settled');
        const s = record(raw, 'settlement', ['attemptId', 'selection', 'inputTokens', 'outputTokens', 'tokens', 'costMicros', 'reportedCostMicros', 'overshootTokens', 'overshootCostMicros', 'settledAt', 'basis']);
        const inputTokens = integer(s.inputTokens, 'inputTokens', 0), outputTokens = integer(s.outputTokens, 'outputTokens', 0);
        const tokens = integer(s.tokens, 'tokens', 0), costMicros = integer(s.costMicros, 'costMicros', 0);
        invariant(tokens === inputTokens + outputTokens, 'UNAVAILABLE', 'Persisted settlement tokens are inconsistent');
        const reported = s.reportedCostMicros === null ? null : integer(s.reportedCostMicros, 'reportedCostMicros', 0);
        const basis = s.basis === undefined ? undefined : text(s.basis, 'charge basis', 64);
        this.settlements.set(id, { attemptId: identifier(s.attemptId, 'attemptId'), selection: storedSelection(s.selection), inputTokens, outputTokens, tokens, costMicros, reportedCostMicros: reported, overshootTokens: integer(s.overshootTokens, 'overshootTokens', 0), overshootCostMicros: integer(s.overshootCostMicros, 'overshootCostMicros', 0), settledAt: integer(s.settledAt, 'settledAt', 0), ...(basis === undefined ? {} : { basis }) });
      }
      // [T10] A journal written before the durable admission counters existed restores them from charged ids:
      // the derived value is an upper bound on every turn/observed number already durable for that hold.
      for (const [id, entry] of restored) {
        invariant(Object.keys(entry.record.turnHolds ?? {}).every(turnId => !this.settlements.has(turnId)), 'UNAVAILABLE', 'Turn is both outstanding and durably charged');
        if (!entry.countersDeclared) {
          for (const settlementId of this.settlements.keys()) {
            if (!settlementId.startsWith(`${id}:`)) continue;
            const turnNumber = /:turn-(\d+)$/.exec(settlementId);
            if (turnNumber) entry.record.admittedTurns = Math.max(entry.record.admittedTurns, Number(turnNumber[1]));
            if (settlementId.startsWith(`${id}:observed-`)) entry.record.observedCharges += 1;
          }
        }
        this.reservations.set(id, entry.record);
      }
      const released = record(o.released, 'model spend releases');
      invariant(Object.keys(released).length <= MODEL_SPEND_MAX_RECORDS, 'OUTPUT_LIMIT', 'Excessive model spend release state');
      for (const [id, raw] of Object.entries(released)) {
        identifier(id, 'releaseId');
        invariant(!this.reservations.has(id) && !this.settlements.has(id), 'UNAVAILABLE', 'Model spend reservation is both released and charged');
        const r = record(raw, 'release', ['attemptId', 'reason', 'releasedAt', 'admittedTurns']);
        this.released.set(id, { attemptId: identifier(r.attemptId, 'attemptId'), reason: text(r.reason, 'release reason', 128), releasedAt: integer(r.releasedAt, 'releasedAt', 0), ...(r.admittedTurns === undefined ? {} : { admittedTurns: integer(r.admittedTurns, 'admittedTurns', 0) }) });
      }
      const committed = record(o.committed, 'model spend committed', ['tokens', 'costMicros']);
      const overshoot = record(o.overshoot, 'model spend overshoot', ['tokens', 'costMicros']);
      let tokens = 0, costMicros = 0, overshootTokens = 0, overshootCostMicros = 0;
      for (const item of this.settlements.values()) { tokens += item.tokens; costMicros += item.costMicros; overshootTokens += item.overshootTokens; overshootCostMicros += item.overshootCostMicros; }
      for (const item of this.reservations.values()) { this.activeTokens += item.reservedTokens; this.activeCostMicros += item.reservedCostMicros; }
      invariant(integer(committed.tokens, 'committed.tokens', 0) === tokens && integer(committed.costMicros, 'committed.costMicros', 0) === costMicros, 'UNAVAILABLE', 'Persisted model spend totals do not match the settled receipts');
      invariant(integer(overshoot.tokens, 'overshoot.tokens', 0) === overshootTokens && integer(overshoot.costMicros, 'overshoot.costMicros', 0) === overshootCostMicros, 'UNAVAILABLE', 'Persisted model spend overshoot does not match the settled receipts');
      invariant(this.activeTokens <= this.limits.maxTokens && this.activeCostMicros <= this.limits.maxCostUsdMicros, 'UNAVAILABLE', 'Persisted active reservations exceed the pinned limits');
      this.committed = { tokens, costMicros };
      this.overshootTotals = { tokens: overshootTokens, costMicros: overshootCostMicros };
    } catch (error) {
      if (error instanceof PolicyError && error.code === 'UNAVAILABLE') throw error;
      throw new PolicyError('UNAVAILABLE', 'Invalid persisted model spend state');
    }
  }

  /** Pre-request enforcement point: refuse before dispatch unless the worst case fits the remaining budget. */
  reserve(request: ModelSpendRequest): ModelSpendReservation {
    this.assertHealthy();
    this.admissionGuard?.();
    invariant(this.overshootTotals.tokens === 0 && this.overshootTotals.costMicros === 0 && this.committed.tokens <= this.limits.maxTokens && this.accountedCostMicros() <= this.limits.maxCostUsdMicros, 'BUDGET_EXCEEDED', 'Measured budget overshoot requires owner reconciliation before another reservation');
    const runId = this.requireRun();
    const attemptId = identifier(request.attemptId, 'attemptId');
    this.assertAttempt(runId, attemptId);
    const selection = this.parseSelection(request.selection);
    const price = this.priceFor(selection);
    const inputTokensUpperBound = integer(request.inputTokensUpperBound, 'inputTokensUpperBound', 0);
    const maxOutputTokens = integer(request.maxOutputTokens, 'maxOutputTokens', 0);
    const reservedTokens = inputTokensUpperBound + maxOutputTokens;
    invariant(Number.isSafeInteger(reservedTokens), 'INVALID_INPUT', 'Reserved token bound is not a safe integer');
    const reservedCostMicros = microUsdForTokens(inputTokensUpperBound, price.inputMicroUsdPerMillion) + microUsdForTokens(maxOutputTokens, price.outputMicroUsdPerMillion);
    // [T11] A deferred catch-up is observed usage the run has already paid for but not charged yet; the part
    // the in-flight turns do not hold is a claim on the headroom, so admission never advertises it as free.
    const deferred = this.deferredClaim();
    invariant(this.committed.tokens + this.activeTokens + deferred.tokens + reservedTokens <= this.limits.maxTokens, 'BUDGET_EXCEEDED', 'Model token budget cannot cover the worst-case reservation');
    invariant(this.accountedCostMicros() + this.activeCostMicros + deferred.costMicros + reservedCostMicros <= this.limits.maxCostUsdMicros, 'BUDGET_EXCEEDED', 'Model cost budget cannot cover the worst-case reservation');
    invariant(this.reservations.size + this.settlements.size + this.released.size < MODEL_SPEND_MAX_RECORDS, 'OUTPUT_LIMIT', 'Model spend ledger record limit reached; refusing further dispatch');
    const reservationId = request.reservationId === undefined ? randomUUID() : identifier(request.reservationId, 'reservationId');
    invariant(!this.reservations.has(reservationId) && !this.settlements.has(reservationId) && !this.released.has(reservationId), 'INVALID_INPUT', 'Reservation identity already used');
    const createdAt = this.now();
    invariant(Number.isSafeInteger(createdAt) && createdAt >= 0, 'UNAVAILABLE', 'Model spend clock unavailable');
    const record: ModelSpendActiveReservation = { attemptId, selection, reservedTokens, reservedCostMicros, createdAt, admittedTurns: 0, observedCharges: 0, openTurns: 0, openTokens: 0, openCostMicros: 0, turnHolds: {} };
    this.reservations.set(reservationId, record);
    this.activeTokens += reservedTokens;
    this.activeCostMicros += reservedCostMicros;
    this.persist();
    return Object.freeze({
      reservationId,
      runId,
      attemptId,
      selection,
      reservedTokens,
      reservedCostUsd: microsToUsd(reservedCostMicros),
      settle: (usage: ModelSpendUsage) => this.settle({ reservationId, attemptId, selection, usage }),
      release: (reason?: string) => { this.release(reservationId, reason); },
    });
  }

  /**
   * [T9/T10] Per-turn admission at the single egress. Every bound is controller-derived: the caller supplies
   * the request payload byte length and the supervisor-declared completion bound, never a worker field.
   * The turn is admitted only while the attempt's launch hold is active and the run's remaining headroom can
   * cover the *whole* worst case of admitted-but-unsettled turns plus this one; otherwise it refuses with
   * `BUDGET_EXCEEDED` and no state change, so no provider request may follow.
   *
   * [T10] The headroom check, the per-turn hold growth and the minting of the turn's identity are one
   * synchronous critical section over the durable state: N overlapping admits can neither share one
   * reservation slot nor collide on a turn id, so every admitted turn is bounded and charged separately.
   * Growth is computed against the in-flight turns (`openTokens`), never against the residual hold alone.
   */
  admitTurn(request: ModelSpendTurnRequest): Readonly<ModelSpendTurn> {
    this.assertHealthy();
    this.admissionGuard?.();
    const admissions = [...this.reservations.values()].reduce((n, r) => n + r.admittedTurns, 0) + [...this.released.entries()].reduce((n, [id, r]) => n + (r.admittedTurns ?? [...this.settlements.keys()].filter(key => key.startsWith(`${id}:turn-`)).length), 0);
    invariant(this.maxTurns === undefined || admissions < this.maxTurns, 'BUDGET_EXCEEDED', 'Finite phase provider-turn allocation exhausted; owner extension required');
    invariant(this.overshootTotals.tokens === 0 && this.overshootTotals.costMicros === 0 && this.committed.tokens <= this.limits.maxTokens && this.committed.costMicros <= this.limits.maxCostUsdMicros, 'BUDGET_EXCEEDED', 'Measured budget overshoot requires owner reconciliation before another provider turn');
    const runId = this.requireRun();
    const reservationId = identifier(request.reservationId, 'reservationId');
    const attemptId = identifier(request.attemptId, 'attemptId');
    this.assertAttempt(runId, attemptId);
    const selection = this.parseSelection(request.selection);
    this.priceFor(selection);
    const inputTokensUpperBound = integer(request.inputTokensUpperBound, 'inputTokensUpperBound', 0);
    const maxOutputTokens = integer(request.maxOutputTokens, 'maxOutputTokens', 0);
    const turnTokens = this.turnBound('tokens', inputTokensUpperBound, maxOutputTokens);
    const turnCostMicros = this.chargeCostMicros(selection, inputTokensUpperBound, maxOutputTokens);
    const active = this.reservations.get(reservationId);
    invariant(active, 'INVALID_INPUT', 'Unknown model spend reservation; a provider turn cannot be admitted without the attempt hold');
    invariant(active.attemptId === attemptId && sameSelection(active.selection, selection), 'IDENTITY_DENIED', 'Turn identity does not match the attempt reservation');
    invariant(active.terminalReconciled !== true, 'BUDGET_EXCEEDED', 'Terminal model reservation is sealed; a fresh authorized attempt is required');
    invariant(active.turnHolds !== undefined || active.openTurns === 0, 'UNAVAILABLE', 'Legacy unknown turn bounds require reconciliation before new admission');
    const growTokens = Math.max(0, active.openTokens + turnTokens - active.reservedTokens);
    const growCostMicros = Math.max(0, active.openCostMicros + turnCostMicros - active.reservedCostMicros);
    if (growTokens > 0 || growCostMicros > 0) {
      // [T11] Same claim as in `reserve`: observed-but-uncharged usage still bounds the next admission.
      const deferred = this.deferredClaim();
      invariant(this.committed.tokens + this.activeTokens + deferred.tokens + growTokens <= this.limits.maxTokens, 'BUDGET_EXCEEDED', "Model token budget cannot cover the next provider turn's worst case");
      invariant(this.accountedCostMicros() + this.activeCostMicros + deferred.costMicros + growCostMicros <= this.limits.maxCostUsdMicros, 'BUDGET_EXCEEDED', "Model cost budget cannot cover the next provider turn's worst case");
      invariant(this.reservations.size + this.settlements.size + this.released.size < MODEL_SPEND_MAX_RECORDS, 'OUTPUT_LIMIT', 'Model spend ledger record limit reached; refusing further dispatch');
    }
    // Minted from the durable per-hold counter (never from the settled-charge count) so concurrent admits are
    // distinct even before either one is charged; the id is still checked against durable records.
    const turn = active.admittedTurns + 1;
    const turnId = `${reservationId}:turn-${turn}`;
    invariant(!this.settlements.has(turnId) && !this.released.has(turnId), 'UNAVAILABLE', 'Model spend turn identity already charged');
    active.admittedTurns = turn;
    active.openTurns += 1;
    active.openTokens += turnTokens;
    active.openCostMicros += turnCostMicros;
    (active.turnHolds ??= {})[turnId] = { inputTokens: inputTokensUpperBound, outputTokens: maxOutputTokens };
    const live = this.liveTurnCoverage(reservationId);
    this.liveTurns.set(reservationId, { turns: live.turns + 1, tokens: live.tokens + turnTokens, costMicros: live.costMicros + turnCostMicros });
    if (growTokens > 0 || growCostMicros > 0) {
      active.reservedTokens += growTokens;
      active.reservedCostMicros += growCostMicros;
      this.activeTokens += growTokens;
      this.activeCostMicros += growCostMicros;
    }
    this.persist();
    // [T11] The durable counters above are the journal's; the in-memory live coverage is the answer to "will
    // any in-flight turn still charge this ledger?" — false for a hold restored from a previous process.
    const charge = (usage: { inputTokens: number; outputTokens: number; reportedCostMicros: number | null }, basis: string) =>
      this.chargeTurn({ reservationId, attemptId, selection, turn, turnId, reservedTokens: turnTokens, reservedOutputTokens: maxOutputTokens, reservedCostMicros: turnCostMicros, openTurn: { tokens: turnTokens, costMicros: turnCostMicros }, usage, basis });
    const assumed = (reason: string) => charge({ inputTokens: inputTokensUpperBound, outputTokens: maxOutputTokens, reportedCostMicros: null }, assumedBasis(reason));
    return Object.freeze({
      turnId,
      turn,
      attemptId,
      selection,
      reservedTokens: turnTokens,
      reservedCostUsd: microsToUsd(turnCostMicros),
      charge: (usage: ModelSpendUsageInput) => charge(this.parseUsage(usage), MODEL_SPEND_BASIS.providerUsage),
      chargeUnobserved: (reason: string) => assumed(text(reason, 'unobserved reason', 64)),
    });
  }

  /**
   * [T9] Charge the observed (session/receipt) usage not yet charged for this attempt. Deltas are taken
   * against what the attempt already paid, so a per-turn gateway charge and a later catch-up never
   * double-charge; an attempt that already paid the assumed worst case pays nothing more for that turn.
   *
   * [T11] While any admitted turn is in flight the observation is **deferred**: it charges nothing, is stored
   * durably on the hold as `deferred` (with `deferredCatchUps` counting the deferrals), and is applied by the
   * next catch-up or by `release`. R4 §4 (W4): charging it immediately charged usage those turns were about to
   * charge again (2 800 committed against a 2 000 limit, `overshoot 0`, three settlements for two turns).
   */
  catchUp(input: ModelSpendCatchUpRequest): Readonly<ModelSpendTurnCharge> | undefined {
    const runId = this.requireRun();
    const reservationId = identifier(input.reservationId, 'reservationId');
    const attemptId = identifier(input.attemptId, 'attemptId');
    this.assertAttempt(runId, attemptId);
    const selection = this.parseSelection(input.selection);
    const observed = this.parseUsage(input.usage);
    const active = this.reservations.get(reservationId);
    invariant(active, 'INVALID_INPUT', 'Unknown model spend reservation; observed usage cannot be charged without the attempt hold');
    invariant(active.attemptId === attemptId && sameSelection(active.selection, selection), 'IDENTITY_DENIED', 'Catch-up identity does not match the attempt reservation');
    const basis = input.basis === undefined ? MODEL_SPEND_BASIS.sessionCatchUp : text(input.basis, 'basis', 64);
    const charged = this.attemptUsage(reservationId, attemptId);
    const inputTokens = Math.max(0, observed.inputTokens - charged.inputTokens);
    const outputTokens = Math.max(0, observed.outputTokens - charged.outputTokens);
    // Nothing new was observed: any earlier deferral is now covered by the turns that settled, so it is
    // cleared as durable evidence of a claim that no longer exists.
    if (inputTokens === 0 && outputTokens === 0 && (observed.reportedCostMicros === null || observed.reportedCostMicros <= Math.round(charged.costUsd * 1_000_000))) { this.clearDeferral(active); return undefined; }
    if (this.liveTurnCoverage(reservationId).turns > 0) {
      // A turn admitted by this ledger is still in flight and any part of this observation may be its usage:
      // its own charge is the authoritative record, so nothing is charged here. The observation is durable on
      // the hold, and the durable `openTurns` counter records why it was deferred.
      const deferredAt = this.now();
      invariant(Number.isSafeInteger(deferredAt) && deferredAt >= 0, 'UNAVAILABLE', 'Model spend clock unavailable');
      active.deferred = { inputTokens: observed.inputTokens, outputTokens: observed.outputTokens, reportedCostMicros: observed.reportedCostMicros, basis, openTurns: active.openTurns, deferredAt };
      active.deferredCatchUps = (active.deferredCatchUps ?? 0) + 1;
      this.persist();
      return undefined;
    }
    return this.chargeObserved({ reservationId, attemptId, selection, active, observed, basis });
  }

  /**
   * [T11] Charge a deferred observation once it can no longer be double-charged. Reached from `catchUp` (no
   * turn open) and from `release` (the terminal path, after which no in-flight turn can charge this hold), and
   * always against the *current* settled state, so a turn that settled in between is never charged twice.
   */
  private chargeObserved(input: { reservationId: string; attemptId: string; selection: ModelSpendSelection; active: ModelSpendActiveReservation; observed: { inputTokens: number; outputTokens: number; reportedCostMicros: number | null }; basis: string }): Readonly<ModelSpendTurnCharge> | undefined {
    const charged = this.attemptUsage(input.reservationId, input.attemptId);
    const inputTokens = Math.max(0, input.observed.inputTokens - charged.inputTokens);
    const outputTokens = Math.max(0, input.observed.outputTokens - charged.outputTokens);
    const chargedMicros = [...this.settlements.entries()].filter(([id, s]) => id.startsWith(`${input.reservationId}:`) && s.attemptId === input.attemptId).reduce((n, [, s]) => n + Math.max(s.costMicros, s.reportedCostMicros ?? 0), 0);
    const reportedDelta = input.observed.reportedCostMicros === null ? null : Math.max(0, input.observed.reportedCostMicros - chargedMicros);
    if (inputTokens === 0 && outputTokens === 0 && (reportedDelta === null || reportedDelta === 0)) { this.clearDeferral(input.active); return undefined; }
    // [T10] The catch-up identity also comes from a durable counter, never from the count of existing records,
    // so two overlapping observations cannot mint the same id and collapse into one charge.
    const observedSeq = input.active.observedCharges + 1;
    const turnId = `${input.reservationId}:observed-${observedSeq}`;
    invariant(!this.settlements.has(turnId) && !this.released.has(turnId), 'UNAVAILABLE', 'Model spend catch-up identity already charged');
    // The deferral is cleared in the same durable state that carries the settlement; a failed charge restores
    // it in memory so the hold keeps claiming the usage it has not been paid for.
    // [T12] Remove the key, never assign `undefined`: both the deferral clear and the observed charge must
    // persist through the strict journal, and a failed charge rolls the ledger back to the last committed
    // state inside `persist()`, which restores this deferral. A local catch is no longer needed.
    delete input.active.deferred;
    return this.chargeTurn({
      reservationId: input.reservationId, attemptId: input.attemptId, selection: input.selection, turn: charged.turns + 1, turnId,
      reservedTokens: input.active.reservedTokens, reservedCostMicros: input.active.reservedCostMicros, observedSeq,
      usage: { inputTokens, outputTokens, reportedCostMicros: reportedDelta }, basis: input.basis,
    });
  }

  /** Clears a deferral that no longer owes anything, so the durable evidence matches the settled state. */
  private clearDeferral(active: ModelSpendActiveReservation): void {
    if (!active.deferred) return;
    delete active.deferred;
    this.persist();
  }

  /** [T11] Admission-time claim of deferred observations, in tokens and micro-USD (see `deferredClaim`). */
  private deferredClaim(): { tokens: number; costMicros: number } {
    let tokens = 0, costMicros = 0;
    for (const [reservationId, active] of this.reservations) {
      const deferred = active.deferred;
      if (!deferred) continue;
      let chargedTokens = 0, chargedMicros = 0;
      for (const [settlementId, record] of this.settlements) {
        if (!settlementId.startsWith(`${reservationId}:`) || record.attemptId !== active.attemptId) continue;
        chargedTokens += record.tokens; chargedMicros += Math.max(record.costMicros, record.reportedCostMicros ?? 0);
      }
      const price = this.priceFor(active.selection);
      const observedMicros = Math.max(deferred.reportedCostMicros ?? 0, microUsdForTokens(deferred.inputTokens, price.inputMicroUsdPerMillion) + microUsdForTokens(deferred.outputTokens, price.outputMicroUsdPerMillion));
      // Only the part that no live in-flight turn still holds and that is not charged yet is a claim on the
      // run's remaining headroom: the rest of the observation is already reserved by those turns or paid.
      const live = this.liveTurnCoverage(reservationId);
      tokens += Math.max(0, deferred.inputTokens + deferred.outputTokens - chargedTokens - live.tokens);
      costMicros += Math.max(0, observedMicros - chargedMicros - live.costMicros);
    }
    return { tokens, costMicros };
  }

  /** [T11] Worst-case coverage still held by turns admitted by this ledger instance (0 after a restore). */
  private liveTurnCoverage(reservationId: string): { turns: number; tokens: number; costMicros: number } {
    return this.liveTurns.get(reservationId) ?? { turns: 0, tokens: 0, costMicros: 0 };
  }


  /** [T9] Cumulative usage already charged against one attempt reservation (turn and catch-up records). */
  attemptUsage(reservationId: string, attemptId?: string): Readonly<ModelSpendAttemptUsage> {
    const id = identifier(reservationId, 'reservationId');
    let turns = 0, catchUps = 0, assumedTurns = 0, inputTokens = 0, outputTokens = 0, costMicros = 0;
    for (const [settlementId, record] of this.settlements) {
      if (!settlementId.startsWith(`${id}:`)) continue;
      if (attemptId !== undefined && record.attemptId !== attemptId) continue;
      turns += 1;
      if (settlementId.startsWith(`${id}:observed-`)) catchUps += 1;
      if ((record.basis ?? '').startsWith(MODEL_SPEND_BASIS.assumedWorstCase)) assumedTurns += 1;
      inputTokens += record.inputTokens; outputTokens += record.outputTokens; costMicros += record.costMicros;
    }
    return Object.freeze({ turns, catchUps, assumedTurns, inputTokens, outputTokens, tokens: inputTokens + outputTokens, costUsd: microsToUsd(costMicros) });
  }

  private turnBound(label: string, inputTokensUpperBound: number, maxOutputTokens: number): number {
    const bound = inputTokensUpperBound + maxOutputTokens;
    invariant(Number.isSafeInteger(bound), 'INVALID_INPUT', `Turn ${label} bound is not a safe integer`);
    return bound;
  }

  private chargeCostMicros(selection: ModelSpendSelection, inputTokens: number, outputTokens: number): number {
    const price = this.priceFor(selection);
    return microUsdForTokens(inputTokens, price.inputMicroUsdPerMillion) + microUsdForTokens(outputTokens, price.outputMicroUsdPerMillion);
  }

  /**
   * [T9/T10] One durable charge against the attempt hold. Idempotent by `turnId`; the hold is consumed by the
   * charged amount (never more), overshoot is measured against the bound admitted for this charge, and a
   * charge above the hold still happens (the tokens are spent) while the excess is explicit overshoot.
   *
   * [T10] An admitted turn is removed from the in-flight set here, and a charging turn may only consume the
   * part of the hold that is not still reserved for other in-flight turns: an overshooting turn can never
   * silently eat another concurrent turn's worst-case reservation.
   */
  private chargeTurn(input: { reservationId: string; attemptId: string; selection: ModelSpendSelection; turn: number; turnId: string; reservedTokens: number; reservedOutputTokens?: number; reservedCostMicros: number; openTurn?: { tokens: number; costMicros: number }; observedSeq?: number; usage: { inputTokens: number; outputTokens: number; reportedCostMicros: number | null }; basis: string }): Readonly<ModelSpendTurnCharge> {
    this.requireRun();
    const existing = this.settlements.get(input.turnId);
    if (existing) {
      invariant(existing.attemptId === input.attemptId && sameSelection(existing.selection, input.selection) && existing.inputTokens === input.usage.inputTokens && existing.outputTokens === input.usage.outputTokens && existing.reportedCostMicros === input.usage.reportedCostMicros && (existing.basis ?? MODEL_SPEND_BASIS.providerUsage) === input.basis, 'IDENTITY_DENIED', 'Turn settlement replay does not match the recorded receipt');
      return this.turnResult(input.turnId, input.turn, existing, true);
    }
    invariant(!this.released.has(input.turnId), 'INVALID_INPUT', 'Turn settlement was released; late usage cannot be charged');
    const active = this.reservations.get(input.reservationId);
    invariant(active, 'INVALID_INPUT', 'Model spend attempt hold is no longer active; refusing to charge a turn without a hold');
    invariant(active.attemptId === input.attemptId && sameSelection(active.selection, input.selection), 'IDENTITY_DENIED', 'Charge identity does not match the attempt reservation');
    const tokens = input.usage.inputTokens + input.usage.outputTokens;
    invariant(Number.isSafeInteger(tokens), 'INVALID_INPUT', 'Observed token usage is not a safe integer');
    invariant(this.settlements.size + this.released.size < MODEL_SPEND_MAX_RECORDS, 'OUTPUT_LIMIT', 'Model spend ledger record limit reached; refusing further charges');
    const costMicros = this.chargeCostMicros(input.selection, input.usage.inputTokens, input.usage.outputTokens);
    const overshootTokens = Math.max(0, tokens - input.reservedTokens, input.usage.outputTokens - (input.reservedOutputTokens ?? input.usage.outputTokens));
    const overshootCostMicros = Math.max(0, Math.max(costMicros, input.usage.reportedCostMicros ?? 0) - input.reservedCostMicros);
    // [T10] Consume only what is not reserved for turns still in flight (this turn's own bound stops being
    // in flight now, so it becomes claimable here).
    const stillOpenTokens = Math.max(0, active.openTokens - (input.openTurn?.tokens ?? 0));
    const stillOpenCostMicros = Math.max(0, active.openCostMicros - (input.openTurn?.costMicros ?? 0));
    const consumedTokens = Math.min(tokens, Math.max(0, active.reservedTokens - stillOpenTokens));
    const consumedCostMicros = Math.min(costMicros, Math.max(0, active.reservedCostMicros - stillOpenCostMicros));
    if (input.openTurn) {
      invariant(active.openTurns > 0, 'UNAVAILABLE', 'Model spend in-flight turn accounting is inconsistent');
      if (active.turnHolds) delete active.turnHolds[input.turnId];
      active.openTurns -= 1;
      active.openTokens = stillOpenTokens;
      active.openCostMicros = stillOpenCostMicros;
      const live = this.liveTurnCoverage(input.reservationId);
      const remaining = { turns: Math.max(0, live.turns - 1), tokens: Math.max(0, live.tokens - input.openTurn.tokens), costMicros: Math.max(0, live.costMicros - input.openTurn.costMicros) };
      if (remaining.turns === 0) this.liveTurns.delete(input.reservationId);
      else this.liveTurns.set(input.reservationId, remaining);
    }
    if (input.observedSeq !== undefined) active.observedCharges = input.observedSeq;
    active.reservedTokens -= consumedTokens;
    active.reservedCostMicros -= consumedCostMicros;
    this.activeTokens -= consumedTokens;
    this.activeCostMicros -= consumedCostMicros;
    this.committed.tokens += tokens;
    this.committed.costMicros += costMicros;
    this.overshootTotals.tokens += overshootTokens;
    this.overshootTotals.costMicros += overshootCostMicros;
    const settledAt = this.now();
    invariant(Number.isSafeInteger(settledAt) && settledAt >= 0, 'UNAVAILABLE', 'Model spend clock unavailable');
    const record: ModelSpendSettlementRecord = { attemptId: input.attemptId, selection: input.selection, inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens, tokens, costMicros, reportedCostMicros: input.usage.reportedCostMicros, overshootTokens, overshootCostMicros, settledAt, basis: input.basis };
    this.settlements.set(input.turnId, record);
    // [T12] A charge that cannot be committed marks its own hold as unbounded-by-evidence: the durable
    // state rolled back to the admission hold, and a later `release` may only drop it after a successful
    // charge (never silently, which would under-count provider-paid usage).
    try { this.persist(); }
    catch (error) { this.unpersistedCharges.add(input.reservationId); throw error; }
    this.unpersistedCharges.delete(input.reservationId);
    return this.turnResult(input.turnId, input.turn, record, false);
  }

  private turnResult(turnId: string, turn: number, record: ModelSpendSettlementRecord, duplicate: boolean): Readonly<ModelSpendTurnCharge> {
    return Object.freeze({
      turnId,
      turn,
      attemptId: record.attemptId,
      selection: record.selection,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      tokens: record.tokens,
      costUsd: microsToUsd(record.costMicros),
      costMicros: record.costMicros,
      ...(record.reportedCostMicros === null ? {} : { reportedCostUsd: microsToUsd(record.reportedCostMicros) }),
      overshoot: Object.freeze({ tokens: record.overshootTokens, costUsd: microsToUsd(record.overshootCostMicros) }),
      basis: record.basis ?? MODEL_SPEND_BASIS.providerUsage,
      assumed: (record.basis ?? '').startsWith(MODEL_SPEND_BASIS.assumedWorstCase),
      duplicate,
      settledAt: record.settledAt,
      snapshot: this.snapshot(),
    });
  }
  /** Idempotent settlement: replaying the same receipt returns the recorded charge without double-charging. */
  settle(input: ModelSpendSettlementInput): Readonly<ModelSpendSettlement> {
    this.requireRun();
    const reservationId = identifier(input.reservationId, 'reservationId');
    const attemptId = identifier(input.attemptId, 'attemptId');
    const selection = this.parseSelection(input.selection);
    const usage = this.parseUsage(input.usage);
    const existing = this.settlements.get(reservationId);
    if (existing) {
      invariant(existing.attemptId === attemptId && sameSelection(existing.selection, selection) && existing.inputTokens === usage.inputTokens && existing.outputTokens === usage.outputTokens && existing.reportedCostMicros === usage.reportedCostMicros, 'IDENTITY_DENIED', 'Settlement replay does not match the recorded receipt');
      return this.settlementResult(reservationId, existing, true);
    }
    invariant(!this.released.has(reservationId), 'INVALID_INPUT', 'Model spend reservation was released; late usage cannot be charged');
    const active = this.reservations.get(reservationId);
    invariant(active, 'INVALID_INPUT', 'Unknown model spend reservation');
    // [T9] A cumulative settlement on top of per-turn charges would double-charge the same usage.
    invariant(this.attemptUsage(reservationId, attemptId).turns === 0, 'INVALID_INPUT', 'Model spend attempt already charged per turn; a cumulative settlement would double-charge it');
    invariant(active.attemptId === attemptId && sameSelection(active.selection, selection), 'IDENTITY_DENIED', 'Settlement identity does not match the reservation');
    const price = this.priceFor(selection);
    const tokens = usage.inputTokens + usage.outputTokens;
    invariant(Number.isSafeInteger(tokens), 'INVALID_INPUT', 'Observed token usage is not a safe integer');
    const costMicros = microUsdForTokens(usage.inputTokens, price.inputMicroUsdPerMillion) + microUsdForTokens(usage.outputTokens, price.outputMicroUsdPerMillion);
    const overshootTokens = Math.max(0, tokens - active.reservedTokens);
    const overshootCostMicros = Math.max(0, Math.max(costMicros, usage.reportedCostMicros ?? 0) - active.reservedCostMicros);
    this.reservations.delete(reservationId);
    this.liveTurns.delete(reservationId);
    this.activeTokens -= active.reservedTokens;
    this.activeCostMicros -= active.reservedCostMicros;
    this.committed.tokens += tokens;
    this.committed.costMicros += costMicros;
    this.overshootTotals.tokens += overshootTokens;
    this.overshootTotals.costMicros += overshootCostMicros;
    const record: ModelSpendSettlementRecord = { attemptId, selection, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, tokens, costMicros, reportedCostMicros: usage.reportedCostMicros, overshootTokens, overshootCostMicros, settledAt: this.now() };
    this.settlements.set(reservationId, record);
    try { this.persist(); }
    catch (error) { this.unpersistedCharges.add(reservationId); throw error; }
    this.unpersistedCharges.delete(reservationId);
    return this.settlementResult(reservationId, record, false);
  }

  /**
   * Cancellation/failure/terminal path: drop the active reservation. Idempotent.
   *
   * [T11] An observation deferred because turns were in flight is charged here first (the terminal retry): after
   * this call no in-flight turn can charge this hold, so the deferred usage can no longer be double-charged, and
   * it is never dropped with the hold either. A charge that cannot be persisted fails closed: the hold remains
   * for restart reconciliation.
   */
  /** Terminal reconciliation is supervisor-only. Complete cumulative usage requires independent collection evidence, not worker prose. */
  reconcileTerminal(reservationId: string, proof: { terminationVerified: true; reference: string; usage?: ModelSpendUsageInput; completeUsageVerified?: true }): void {
    invariant(proof.terminationVerified === true, 'UNAVAILABLE', 'Verified termination required for terminal spend reconciliation');
    text(proof.reference, 'terminal reconciliation reference', 256);
    const id = identifier(reservationId, 'reservationId');
    const active = this.reservations.get(id);
    invariant(active, 'INVALID_INPUT', 'Unknown model spend reservation');
    active.terminalReconciled = true;
    this.persist();
    invariant(proof.completeUsageVerified === true || this.liveTurnCoverage(id).turns === 0, 'UNAVAILABLE', 'Gateway provider turns are still live; their worst-case holds remain until gateway settlement or restart reconciliation');
    if (proof.completeUsageVerified === true) {
      invariant(proof.usage !== undefined, 'INVALID_INPUT', 'Complete usage evidence is absent');
      // Termination proves no old turn can subsequently settle; catch-up owns the cumulative observation.
      this.liveTurns.delete(id);
      this.catchUp({ reservationId: id, attemptId: active.attemptId, selection: active.selection, usage: proof.usage });
      const current = this.reservations.get(id)!;
      current.openTurns = 0; current.openTokens = 0; current.openCostMicros = 0; current.turnHolds = {};
      this.unpersistedCharges.delete(id);
      this.persist();
      return;
    }
    // No complete observation: charge each exact admitted worst case, keeping turn ids unique across restart.
    invariant(active.turnHolds !== undefined || active.openTurns === 0, 'UNAVAILABLE', 'Legacy unknown turn bounds retained for manual reconciliation');
    for (const [turnId, bound] of Object.entries(active.turnHolds ?? {})) {
      const tokens = bound.inputTokens + bound.outputTokens;
      const costMicros = this.chargeCostMicros(active.selection, bound.inputTokens, bound.outputTokens);
      this.chargeTurn({ reservationId: id, attemptId: active.attemptId, selection: active.selection, turn: Number(turnId.split(':turn-')[1]), turnId, reservedTokens: tokens, reservedOutputTokens: bound.outputTokens, reservedCostMicros: costMicros, openTurn: { tokens, costMicros }, usage: { ...bound, reportedCostMicros: null }, basis: assumedBasis('terminal-usage-unknown') });
    }
    if (proof.usage) this.catchUp({ reservationId: id, attemptId: active.attemptId, selection: active.selection, usage: proof.usage });
  }

  release(reservationId: string, reason?: string): boolean {
    this.requireRun();
    const id = identifier(reservationId, 'reservationId');
    const note = reason === undefined ? 'released' : text(reason, 'release reason', 128);
    // [T12] One bounded retry on the terminal path. `persist()` has already rolled the ledger back to the
    // last commit, so the retry replays the release from that exact durable state; a second failure is
    // reported to the caller, never hidden, and leaves the hold for restart reconciliation.
    for (let attempt = 0; ; attempt += 1) {
      try { return this.releaseOnce(id, note); }
      catch (error) {
        if (attempt >= 1 || !(error instanceof PolicyError) || error.code !== 'UNAVAILABLE') throw error;
      }
    }
  }

  private releaseOnce(id: string, note: string): boolean {
    if (this.released.has(id)) return false;
    invariant(!this.settlements.has(id), 'INVALID_INPUT', 'Model spend reservation already settled; release would erase observed spend');
    const active = this.reservations.get(id);
    invariant(active, 'INVALID_INPUT', 'Unknown model spend reservation');
    // [T12] Fail closed on the one case where a release would erase provider-paid usage: the hold's own
    // charge could not be committed and there is no durable deferral left to re-charge it. The retry path
    // is `catchUp` (which charges the recovered observation and clears this) or a restarted reconciliation.
    invariant(!(this.unpersistedCharges.has(id) && !active.deferred), 'UNAVAILABLE', 'Model spend observed usage could not be persisted; the hold is retained for reconciliation');
    if (active.deferred) {
      const deferred = active.deferred;
      this.chargeObserved({ reservationId: id, attemptId: active.attemptId, selection: active.selection, active, observed: { inputTokens: deferred.inputTokens, outputTokens: deferred.outputTokens, reportedCostMicros: deferred.reportedCostMicros }, basis: deferred.basis });
    }
    invariant(active.openTurns === 0, 'UNAVAILABLE', 'Unobserved admitted provider turns retain their worst-case reserve; restart reconciliation required before release');
    this.reservations.delete(id);
    this.liveTurns.delete(id);
    this.activeTokens -= active.reservedTokens;
    this.activeCostMicros -= active.reservedCostMicros;
    this.released.set(id, Object.freeze({ attemptId: active.attemptId, reason: note, releasedAt: this.now(), admittedTurns: active.admittedTurns }));
    this.persist();
    return true;
  }

  private settlementResult(reservationId: string, record: ModelSpendSettlementRecord, duplicate: boolean): Readonly<ModelSpendSettlement> {
    return Object.freeze({
      reservationId,
      attemptId: record.attemptId,
      selection: record.selection,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      tokens: record.tokens,
      costUsd: microsToUsd(record.costMicros),
      ...(record.reportedCostMicros === null ? {} : { reportedCostUsd: microsToUsd(record.reportedCostMicros) }),
      overshoot: Object.freeze({ tokens: record.overshootTokens, costUsd: microsToUsd(record.overshootCostMicros) }),
      duplicate,
      settledAt: record.settledAt,
      snapshot: this.snapshot(),
    });
  }

  private accountedCostMicros(): number {
    return [...this.settlements.values()].reduce((sum, record) => sum + Math.max(record.costMicros, record.reportedCostMicros ?? 0), 0);
  }

  snapshot(): Readonly<ModelSpendSnapshot> {
    this.assertHealthy();
    const runId = this.requireRun();
    const deferred = this.deferredClaim();
    return Object.freeze({
      runId,
      limits: Object.freeze({ maxTokens: this.limits.maxTokens, maxCostUsd: microsToUsd(this.limits.maxCostUsdMicros) }),
      committed: Object.freeze({ tokens: this.committed.tokens, costUsd: microsToUsd(this.committed.costMicros) }),
      costPolicy: 'pinned-cache-miss-price',
      observedCostUsd: this.settlements.size > 0 && [...this.settlements.values()].every(s => s.reportedCostMicros !== null) ? microsToUsd([...this.settlements.values()].reduce((n, s) => n + s.reportedCostMicros!, 0)) : null,
      accountedCostUsd: microsToUsd(this.accountedCostMicros()),
      active: Object.freeze({ count: this.reservations.size, tokens: this.activeTokens, costUsd: microsToUsd(this.activeCostMicros) }),
      remaining: Object.freeze({
        tokens: Math.max(0, this.limits.maxTokens - this.committed.tokens - this.activeTokens - deferred.tokens),
        costUsd: microsToUsd(Math.max(0, this.limits.maxCostUsdMicros - this.accountedCostMicros() - this.activeCostMicros - deferred.costMicros)),
      }),
      overshoot: Object.freeze({ tokens: this.overshootTotals.tokens, costUsd: microsToUsd(this.overshootTotals.costMicros) }),
      breach: Object.freeze({
        tokens: Math.max(0, this.committed.tokens - this.limits.maxTokens),
        costUsd: microsToUsd(Math.max(0, this.accountedCostMicros() - this.limits.maxCostUsdMicros)),
      }),
      deferred: Object.freeze({
        holds: [...this.reservations.values()].filter(active => active.deferred !== undefined).length,
        tokens: [...this.reservations.values()].reduce((total, active) => total + (active.deferred === undefined ? 0 : active.deferred.inputTokens + active.deferred.outputTokens), 0),
        claimedTokens: deferred.tokens,
        claimedCostUsd: microsToUsd(deferred.costMicros),
      }),
      settlements: this.settlements.size,
      released: this.released.size,
    });
  }

  /** In-flight reservations a restarted supervisor must reconcile instead of dropping. */
  activeReservations(): readonly Readonly<{ reservationId: string; attemptId: string; selection: ModelSpendSelection; reservedTokens: number; reservedCostUsd: number; createdAt: number }>[] {
    this.requireRun();
    return Object.freeze([...this.reservations].map(([reservationId, r]) => Object.freeze({ reservationId, attemptId: r.attemptId, selection: r.selection, reservedTokens: r.reservedTokens, reservedCostUsd: microsToUsd(r.reservedCostMicros), createdAt: r.createdAt })).sort((a, b) => a.reservationId.localeCompare(b.reservationId)));
  }
}
export type AutonomousBudgetPhase = 'planner' | 'workers' | 'verifier' | 'report';
export interface AutonomousPhaseRequest { selection: ModelSpendSelection; inputTokensUpperBound: number; maxOutputTokens: number; maxTurns: number }
export interface AutonomousPhaseAllocation extends AutonomousPhaseRequest { limits: ModelSpendLimits }
export type AutonomousModelBudgetPlan =
  | { outcome: 'ready'; ownerLimits: ModelSpendLimits; phases: Record<AutonomousBudgetPhase, AutonomousPhaseAllocation>; allocated: ModelSpendLimits; prices: ModelPriceTable; policy: 'isolated-phase-caps-no-borrowing' }
  | { outcome: 'partial'; reason: 'budget-extension-required'; required: ModelSpendLimits; ownerLimits: ModelSpendLimits; shortfall: ModelSpendLimits; launchAllowed: false };
/** Finite, owner-capped allocation BEFORE launch. Phase ledgers/journals must be isolated; never share worker headroom with verifier/report. */
export function planAutonomousModelBudget(owner: ModelSpendLimits, requests: Readonly<Record<AutonomousBudgetPhase, AutonomousPhaseRequest>>, prices: ModelPriceTable = PINNED_MODEL_PRICES): Readonly<AutonomousModelBudgetPlan> {
  const ownerLimits = { maxTokens: integer(owner.maxTokens, 'owner.maxTokens', 0), maxCostUsd: microsToUsd(Math.floor(money(owner.maxCostUsd, 'owner.maxCostUsd') * 1_000_000)) };
  const phases = {} as Record<AutonomousBudgetPhase, AutonomousPhaseAllocation>;
  let tokens = 0, micros = 0;
  for (const phase of ['planner', 'workers', 'verifier', 'report'] as const) {
    const request = requests[phase];
    invariant(request, 'INVALID_INPUT', `Explicit finite ${phase} allocation required`);
    const selection = storedSelection(request.selection);
    const input = integer(request.inputTokensUpperBound, `${phase}.input`, 1);
    const output = integer(request.maxOutputTokens, `${phase}.output`, 1);
    const turns = integer(request.maxTurns, `${phase}.turns`, 1, MODEL_SPEND_MAX_RECORDS - 1);
    const price = prices[modelPriceKey(selection.provider, selection.model)];
    invariant(price, 'BUDGET_EXCEEDED', `No pinned ${phase} model price`);
    const phaseTokens = (input + output) * turns;
    const phaseMicros = (microUsdForTokens(input, price.inputMicroUsdPerMillion) + microUsdForTokens(output, price.outputMicroUsdPerMillion)) * turns;
    invariant(Number.isSafeInteger(phaseTokens) && Number.isSafeInteger(phaseMicros), 'INVALID_INPUT', 'Phase budget arithmetic overflow');
    phases[phase] = { selection, inputTokensUpperBound: input, maxOutputTokens: output, maxTurns: turns, limits: { maxTokens: phaseTokens, maxCostUsd: microsToUsd(phaseMicros) } };
    tokens += phaseTokens; micros += phaseMicros;
  }
  invariant(Number.isSafeInteger(tokens) && Number.isSafeInteger(micros), 'INVALID_INPUT', 'Plan budget arithmetic overflow');
  const allocated = { maxTokens: tokens, maxCostUsd: microsToUsd(micros) };
  if (tokens > ownerLimits.maxTokens || micros > usdToMicros(ownerLimits.maxCostUsd)) return deepFreeze({ outcome: 'partial', reason: 'budget-extension-required', required: allocated, ownerLimits, shortfall: { maxTokens: Math.max(0, tokens - ownerLimits.maxTokens), maxCostUsd: microsToUsd(Math.max(0, micros - usdToMicros(ownerLimits.maxCostUsd))) }, launchAllowed: false });
  return deepFreeze({ outcome: 'ready', ownerLimits, phases, allocated, prices: structuredClone(prices), policy: 'isolated-phase-caps-no-borrowing' });
}

/** Construct once per owner run. Separate namespaced durable ledgers prevent workers borrowing verifier/report reserves. */
export function createAutonomousPhaseBudgets(plan: Readonly<AutonomousModelBudgetPlan>, options: { runId: string; journals?: Record<AutonomousBudgetPhase, ModelSpendJournal>; freshRun?: boolean; now?: () => number }): Readonly<Record<AutonomousBudgetPhase, ModelSpendBudget>> {
  invariant(plan.outcome === 'ready', 'BUDGET_EXCEEDED', 'Partial budget plan requires owner extension; no phase may launch');
  invariant(!options.journals || new Set(Object.values(options.journals)).size === 4, 'INVALID_INPUT', 'Durable phases require four isolated journal namespaces');
  const budgets = {} as Record<AutonomousBudgetPhase, ModelSpendBudget>;
  const guard = (): void => {
    for (const [phase, ledger] of Object.entries(budgets)) {
      const s = ledger.snapshot();
      invariant(s.overshoot.tokens === 0 && s.overshoot.costUsd === 0 && s.breach.tokens === 0 && s.breach.costUsd === 0, 'BUDGET_EXCEEDED', `Measured ${phase} overshoot blocks all phase dispatch; owner reconciliation required`);
    }
  };
  for (const phase of ['planner', 'workers', 'verifier', 'report'] as const) {
    const allocation = plan.phases[phase];
    budgets[phase] = new ModelSpendBudget(allocation.limits, { runId: options.runId, admissionGuard: guard, ...(options.now ? { now: options.now } : {}), ...(options.freshRun === undefined ? {} : { freshRun: options.freshRun }), ...(options.journals ? { journal: options.journals[phase] } : {}), prices: plan.prices, maxTurns: allocation.maxTurns, selection: allocation.selection });
  }
  return Object.freeze(budgets);
}


/**
 * The single model-spend enforcement entry point. Two modes:
 *
 * - **inline** (`dispatchModelRequest(ledger, request, dispatch, observeUsage)`): the caller issues the
 *   provider request inside `dispatch`; the reservation is taken before it, settled with the usage the
 *   provider reported and released when the dispatch fails.
 * - **controller-deferred** (`dispatchModelRequest(ledger, request, { deferred: true })`): the provider
 *   traffic is issued by a separate worker process the controller does not execute, so the controller holds
 *   the reservation (`reserve` before dispatch) and applies the observed cumulative usage when the worker
 *   settles. This is the mode `ManagedRuntime` uses.
 */
export interface ModelSpendDispatch {
  readonly reservation: ModelSpendReservation;
  settle(usage: ModelSpendUsageInput): Readonly<ModelSpendSettlement>;
  release(reason?: string): void;
}

/** [T8/S1] Read-only preflight check: a selection the pinned catalog cannot price can never be bounded. */
export function assertModelSpendPrice(selection: ModelSpendSelection, prices: ModelPriceTable = PINNED_MODEL_PRICES): void {
  invariant(prices[modelPriceKey(selection.provider, selection.model)], 'BUDGET_EXCEEDED', `No pinned price for ${selection.provider}/${selection.model}; the request cannot be bounded`);
}

export function dispatchModelRequest(ledger: ModelSpendBudget, request: ModelSpendRequest, options: { signal?: AbortSignal; deferred: true }): ModelSpendDispatch;
export async function dispatchModelRequest<T>(
  ledger: ModelSpendBudget,
  request: ModelSpendRequest,
  dispatch: (reservation: Readonly<ModelSpendReservation>, signal?: AbortSignal) => Promise<T>,
  observeUsage: (result: T) => ModelSpendUsageInput,
  options?: { signal?: AbortSignal },
): Promise<T>;
export function dispatchModelRequest<T>(
  ledger: ModelSpendBudget,
  request: ModelSpendRequest,
  dispatchOrOptions: ((reservation: Readonly<ModelSpendReservation>, signal?: AbortSignal) => Promise<T>) | { signal?: AbortSignal; deferred: true },
  observeUsage?: (result: T) => ModelSpendUsageInput,
  options: { signal?: AbortSignal } = {},
): Promise<T> | ModelSpendDispatch {
  if (typeof dispatchOrOptions !== 'function') {
    checkCancelled(dispatchOrOptions.signal);
    const reservation = ledger.reserve(request);
    return Object.freeze({
      reservation,
      settle: (usage: ModelSpendUsageInput) => reservation.settle(usage),
      release: (reason?: string) => { reservation.release(reason); },
    });
  }
  return (async () => {
    checkCancelled(options.signal);
    const reservation = ledger.reserve(request);
    let result: T;
    try { result = await dispatchOrOptions(reservation, options.signal); }
    catch (error) {
      try { reservation.release('dispatch-failed'); } catch { /* a poisoned journal already denies further dispatch */ }
      throw error;
    }
    reservation.settle(observeUsage!(result));
    checkCancelled(options.signal);
    return result;
  })();
}

import { invariant, PolicyError } from './errors.js';
import { deepFreeze, digest, identifier, integer, list, record, text } from './validation.js';
/** One supervisor-owned instance per run. Atomic local admission; not a distributed rate limiter. */
export class TargetBudget {
    counters = new Map();
    limits = new Map();
    grantCalls = new Map();
    artifacts = new Map();
    now;
    journal;
    boundRunId;
    poisoned = false;
    durable;
    constructor(targets, options = {}) {
        this.now = options.now ?? Date.now;
        this.journal = options.journal;
        this.durable = !!options.journal;
        if (options.runId)
            this.boundRunId = identifier(options.runId, 'budget.runId');
        for (const target of targets) {
            identifier(target.id, 'budget.targetId');
            invariant(!this.limits.has(target.id), 'INVALID_INPUT', 'Duplicate budget target');
            const limits = target.limits;
            integer(limits.maxRequests, 'maxRequests');
            integer(limits.maxBytes, 'maxBytes');
            integer(limits.maxConcurrent, 'maxConcurrent', 1, 128);
            integer(limits.rate.requests, 'rate.requests', 1, 4096);
            integer(limits.rate.windowMs, 'rate.windowMs', 1, 86400000);
            this.limits.set(target.id, deepFreeze(structuredClone(limits)));
            this.counters.set(target.id, { requests: 0, bytes: 0, active: 0, timestamps: [], lastNow: 0 });
        }
        if (this.journal) {
            invariant(this.boundRunId, 'INVALID_INPUT', 'Durable budgets require explicit run identity');
            let prior;
            try {
                prior = this.journal.load(this.boundRunId);
            }
            catch {
                throw new PolicyError('UNAVAILABLE', 'Durable budget state could not be loaded');
            }
            if (prior !== undefined && prior !== null) {
                invariant(options.freshRun !== true, 'UNAVAILABLE', 'Run budget already exists; refusing to reset it');
                this.restore(prior);
            }
            else {
                invariant(options.freshRun === true, 'UNAVAILABLE', 'Missing restart budget state; explicit fresh-run admission required');
                this.persist();
            }
        }
    }
    /** Prevent accidental per-tool/foreign-run counters or a looser budget configuration. */
    bindRun(runId, targets) {
        identifier(runId, 'runId');
        invariant(!this.boundRunId || this.boundRunId === runId, 'IDENTITY_DENIED', 'Budget belongs to a different run');
        for (const target of targets) {
            const l = this.limits.get(target.id), s = target.limits;
            invariant(l && l.maxRequests <= s.maxRequests && l.maxBytes <= s.maxBytes && l.maxConcurrent <= s.maxConcurrent && l.rate.requests <= s.rate.requests && l.rate.windowMs >= s.rate.windowMs, 'BUDGET_EXCEEDED', 'Budget is absent or wider than approved target limits');
        }
        this.boundRunId = runId;
    }
    assertHealthy() { invariant(!this.poisoned, 'UNAVAILABLE', 'Budget journal failed; further dispatch is denied'); }
    persist() {
        if (!this.journal)
            return;
        try {
            const result = this.journal.save(this.exportState());
            invariant(!(result && typeof result.then === 'function'), 'UNAVAILABLE', 'Budget journal must commit synchronously');
        }
        catch {
            this.poisoned = true;
            throw new PolicyError('UNAVAILABLE', 'Budget persistence failed; no traffic may be dispatched');
        }
    }
    exportState() {
        invariant(this.boundRunId, 'UNAVAILABLE', 'Budget has no run identity');
        return deepFreeze({ version: 1, runId: this.boundRunId, limitsDigest: digest(Object.fromEntries(this.limits)), targets: structuredClone(Object.fromEntries(this.counters)), grantCalls: Object.fromEntries(this.grantCalls), artifactBytes: Object.fromEntries(this.artifacts) });
    }
    restore(value) {
        const o = record(value, 'budget state', ['version', 'runId', 'limitsDigest', 'targets', 'grantCalls', 'artifactBytes']);
        invariant(o.version === 1 && o.runId === this.boundRunId && o.limitsDigest === digest(Object.fromEntries(this.limits)), 'UNAVAILABLE', 'Budget run/limits identity mismatch');
        const targets = record(o.targets, 'budget.targets');
        invariant(Object.keys(targets).length === this.limits.size, 'UNAVAILABLE', 'Budget target set changed');
        for (const [id, limits] of this.limits) {
            const c = record(targets[id], 'counter', ['requests', 'bytes', 'active', 'timestamps', 'lastNow']);
            const counter = { requests: integer(c.requests, 'requests', 0), bytes: integer(c.bytes, 'bytes', 0), active: integer(c.active, 'active', 0, limits.maxConcurrent), timestamps: list(c.timestamps, 'timestamps', (v, l) => integer(v, l, 0), 0, 4096), lastNow: integer(c.lastNow, 'lastNow', 0) };
            invariant(counter.requests >= counter.active && counter.timestamps.length <= counter.requests && counter.timestamps.every((v, i, a) => v <= counter.lastNow && (i === 0 || v >= a[i - 1])), 'UNAVAILABLE', 'Invalid restored budget counters');
            this.counters.set(id, counter);
        }
        for (const [field, map] of [['grantCalls', this.grantCalls], ['artifactBytes', this.artifacts]]) {
            const values = record(o[field], field);
            invariant(Object.keys(values).length <= 4096, 'OUTPUT_LIMIT', 'Excessive grant journal state');
            for (const [id, value] of Object.entries(values))
                map.set(identifier(id, 'grantId'), integer(value, field, 0));
        }
    }
    /** Call only after runtime reconciliation has independently proved old execution terminated. */
    clearActiveAfterReconciliation(targetId, proof) {
        this.assertHealthy();
        invariant(proof.terminationVerified === true, 'UNAVAILABLE', 'Termination proof is required');
        text(proof.reference, 'reconciliation reference');
        const c = this.counters.get(targetId);
        invariant(c, 'TARGET_DENIED', 'Unknown target');
        c.active = 0;
        this.persist();
    }
    chargeCall(grant) {
        this.assertHealthy();
        const count = this.grantCalls.get(grant.id) ?? 0;
        invariant(count < grant.maxCalls, 'BUDGET_EXCEEDED', 'Capability call budget exhausted');
        this.grantCalls.set(grant.id, count + 1);
        this.persist();
    }
    chargeArtifact(grant, bytes) {
        this.assertHealthy();
        integer(bytes, 'artifact bytes', 0);
        const next = (this.artifacts.get(grant.id) ?? 0) + bytes;
        invariant(next <= grant.maxArtifactBytes, 'BUDGET_EXCEEDED', 'Capability artifact budget exhausted');
        this.artifacts.set(grant.id, next);
        this.persist();
    }
    reserve(targetId) {
        this.assertHealthy();
        const c = this.counters.get(targetId), limits = this.limits.get(targetId);
        invariant(c && limits, 'TARGET_DENIED', 'No budget for target');
        const time = Math.max(c.lastNow, this.now());
        invariant(Number.isSafeInteger(time) && time >= 0, 'UNAVAILABLE', 'Budget clock unavailable');
        c.lastNow = time;
        c.timestamps = c.timestamps.filter(t => time - t < limits.rate.windowMs);
        invariant(c.requests < limits.maxRequests && c.bytes < limits.maxBytes && c.active < limits.maxConcurrent, 'BUDGET_EXCEEDED', 'Target request/byte/concurrency budget exhausted');
        invariant(c.timestamps.length < limits.rate.requests, 'RATE_LIMITED', 'Target-wide rate limit exceeded');
        c.requests += 1;
        c.active += 1;
        c.timestamps.push(time);
        this.persist();
        let released = false;
        const persist = () => this.persist(), healthy = () => this.assertHealthy();
        return Object.freeze({
            consumeBytes(bytes) {
                healthy();
                invariant(!released, 'INVALID_INPUT', 'Reservation already released');
                integer(bytes, 'traffic bytes', 0);
                c.bytes += bytes;
                persist(); // failed traffic stays charged; no retry refunds
                invariant(c.bytes <= limits.maxBytes, 'BUDGET_EXCEEDED', 'Target byte budget exhausted');
            },
            release() { if (!released) {
                released = true;
                c.active -= 1;
                persist();
            } },
        });
    }
    snapshot(targetId) {
        const c = this.counters.get(targetId), limits = this.limits.get(targetId);
        invariant(c && limits, 'TARGET_DENIED', 'Unknown budget target');
        const time = Math.max(c.lastNow, this.now());
        return Object.freeze({ requests: c.requests, bytes: c.bytes, active: c.active, windowRequests: c.timestamps.filter(t => time - t < limits.rate.windowMs).length });
    }
    grantSnapshot(grantId) {
        return Object.freeze({ calls: this.grantCalls.get(grantId) ?? 0, artifactBytes: this.artifacts.get(grantId) ?? 0 });
    }
}

import { planAutonomousModelBudget, createAutonomousPhaseBudgets, ModelSpendBudget, modelAccountingPolicy, type AutonomousModelBudgetPlan, type ModelSpendSelection } from '../policy/budget.js';
import type { DurableStore } from '../store/store.js';

/** Fixed finite default workflow, not a percentage budget that grows with owner consent.
 * Report rendering is deterministic; its reserve remains protected even without a dynamic verifier.
 * JSON byte estimation is conservative, not a tokenizer guarantee. Wire usage remains authoritative.
 */
export function defaultAutonomousBudget(limits: { maxTokens: number | null; maxCostUsd: number | null; modelAccounting?: 'informational' }, selection: ModelSpendSelection, modelMaximum: number): Readonly<AutonomousModelBudgetPlan> {
  const policy = modelAccountingPolicy(limits);
  if ('mode' in policy) return Object.freeze({ outcome: 'accounting-only', ownerLimits: policy, selection, policy: 'informational-durable-no-phase-quotas' });
  const output = Math.min(4096, modelMaximum);
  return planAutonomousModelBudget(policy, {
    planner: { selection, inputTokensUpperBound: 16384, maxOutputTokens: output, maxTurns: 1 },
    // The producing worker's bounded program is context + one parallel owner-approved observation batch +
    // packet (three provider turns). The per-turn byte bound is a launch estimate, not a cap on real bytes.
    workers: { selection, inputTokensUpperBound: 8192, maxOutputTokens: output, maxTurns: 3 },
    // A verifier attempt performs exactly its bounded program: context, the one owner-approved baseline, the
    // controller replay and the packet. Four finite provider turns with the same protected reserve total.
    verifier: { selection, inputTokensUpperBound: 8192, maxOutputTokens: Math.min(2048, modelMaximum), maxTurns: 4 },
    report: { selection, inputTokensUpperBound: 1024, maxOutputTokens: Math.min(512, modelMaximum), maxTurns: 1 },
  });
}
export function durableAutonomousPool(store: DurableStore, runId: string, plan: Readonly<AutonomousModelBudgetPlan>) {
  return store.transaction(() => {
  const freshRun = store.bindAutonomousBudget(runId, plan);
  if (plan.outcome === 'accounting-only') {
    // One informational run ledger, not four mandatory financial pools. Phase labels remain provenance.
    const accounting = new ModelSpendBudget(plan.ownerLimits, { runId, freshRun, selection: plan.selection, journal: store.autonomousPhaseJournal(runId, 'workers') });
    return Object.freeze({ planner: accounting, workers: accounting, verifier: accounting, report: accounting });
  }
  return createAutonomousPhaseBudgets(plan, { runId, freshRun, journals: {
    planner: store.autonomousPhaseJournal(runId, 'planner'), workers: store.autonomousPhaseJournal(runId, 'workers'),
    verifier: store.autonomousPhaseJournal(runId, 'verifier'), report: store.autonomousPhaseJournal(runId, 'report'),
  } });
  }); // Missing journals on an existing run fail closed, never reset.
}

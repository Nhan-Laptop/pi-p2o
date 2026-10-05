import type { RunManifest, TaskManifest } from '../../contracts/index.js';
import type { FindingPlan, ObservationCheck, VerificationPlan } from '../types.js';

import type { FindingRecord } from '../../contracts/index.js';
import type { EvidenceVault } from '../../evidence/index.js';
import type { ToolContext } from '../../policy/types.js';
import type { ScopedVerificationPolicy } from './policy.js';

/** Only exact owner-approved read-only differentials; external scope is not implicit authority. */
export const FIRST_USE_REPLAY_CLASS =
  'controller-authorized scoped HTTP/HTTPS read-only differential with receipt-bound claim, baseline, negative control and reproduction';

export interface EvidenceBoundReplayCandidate {
  finding: FindingRecord;
  /** Producer collector baseline receipts, not worker-authored summaries. */
  baselineEvidenceIds: readonly string[];
  /** Reset-dependent/stateful claims are not supported by a fresh verifier session alone. */
  requiresTargetReset: boolean;
}

/** Bounded verifier-attempt budget; only spent when the approved run budget leaves room for it. */
export interface FirstUseVerificationBudget {
  maxRequests: number;
  maxToolCalls: number;
  /** Null only with explicit informational model accounting; legacy numbers remain caps. */
  maxTokens: number | null;
  modelAccounting?: 'informational';
  maxCostUsd: number | null;
}

/**
 * Deterministic controller derivation of one supported verification program from owner-approved checks. It
 * contains no finding promotion and no evidence: the verifier task/plan/claim identity is derived only from the
 * human-approved checks and their controller-owned budget bound, so an owner grant can pre-authorize it.
 */
export interface FirstUseVerificationDraft {
  finding: FindingPlan;
  verification: VerificationPlan;
  verifierTask: TaskManifest;
  verifierCheck: ObservationCheck;
  enrichedChecks: ObservationCheck[];
  replay: FirstUseReplayPlan;
}

export type FirstUseVerificationPlanning =
  | { supported: true; draft: FirstUseVerificationDraft }
  | { supported: false; reason: string };

/** Owner-approved inputs and the bounded verifier reserve; no candidate, vault or capability is required. */
export interface FirstUseVerificationPlanningInput {
  run: RunManifest;
  producerTask: TaskManifest;
  targetId: string;
  /** Exact owner-approved target locator; every recipe URL must stay inside its origin and path prefix. */
  targetLocator: string;
  /** Owner-approved checks materialized from the exact owner-approved plan. Never re-derived or widened here. */
  checks: readonly ObservationCheck[];
  workspaceRoot: string;
  verifierBudget: FirstUseVerificationBudget;
  now: string;
  /**
   * When the controller derived the verifier task from the approved plan; defaults to `now`. Post-admission
   * synthesis passes the original derivation time so the manifest stays the exact owner-authorized identity.
   */
  verifierTaskCreatedAt?: string;
}

export interface FirstUseVerificationInput extends FirstUseVerificationPlanningInput {
  /** Optional only for compatibility at call sites: omission always refuses synthesis. */
  candidate?: EvidenceBoundReplayCandidate;
  vault?: EvidenceVault;
  verificationPolicy?: ScopedVerificationPolicy;
  policyContext?: ToolContext;
}

/** Everything the composition's clean replay environment factory needs; no worker-supplied field reaches it. */
export interface FirstUseReplayPlan {
  /** The exact owner-approved verification plan the composition will resolve from `reporting.verification`. */
  plan: VerificationPlan;
  /** Deterministic observation id of the one approved request the verifier worker performs before replaying. */
  verifierObservationId: string;
  /** Exact approved baseline tool input, used to authenticate the qualification receipt. */
  verifierObservationInput?: ObservationCheck['input'];
  origin: string;
  /** Exactly the owner-approved request URLs the replay may issue; anything else is refused before prepare(). */
  approvedUrls: readonly string[];
  supportedClass: string;
}

export interface FirstUseVerificationLeg {
  /** Exact admitted producer record; reporting must retain these IDs, not nearby packet receipts. */
  candidate: FindingRecord;
  baselineEvidenceIds: readonly string[];
  finding: FindingPlan;
  verification: VerificationPlan;
  verifierTask: TaskManifest;
  verifierCheck: ObservationCheck;
  /**
   * The exact owner-approved checks the verification semantics were derived from, with only the controller-side
   * `test` descriptor added (purpose + invariant + original policy). Inputs, URLs, accounts and expectations are
   * byte-for-byte the owner-approved ones.
   */
  enrichedChecks: ObservationCheck[];
  replay: FirstUseReplayPlan;
}

export type FirstUseVerificationSynthesis =
  | { supported: true; leg: FirstUseVerificationLeg }
  | { supported: false; reason: string };

/**
 * Source-only runs intentionally synthesize **no finding**. A static source scan is an observation, not a
 * demonstrated issue: the report keeps the source receipts and the untested coverage cell with
 * `static-inference`, and any vulnerability claim would need an actual model-authored claim with its own
 * supporting source receipts (the bundled first-use path authors none).
 */
export const SOURCE_ONLY_FINDING_POLICY =
  'no-finding-without-model-claim: source observations stay static-inference and are never converted into a finding or vulnerability claim';

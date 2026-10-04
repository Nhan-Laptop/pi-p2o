/**
 * Plan authoring: bounded validation of model output and the plan seal.
 *
 * Model output is untrusted data. Every step, observation and request is schema-validated, bounded and
 * checked against the owner-approved menu/envelope before it can be stored; the author may only narrow the
 * routed technique and the owner scope. The sealed digest covers the preparation, the steps and the exact
 * packet, so the human approves one immutable value.
 */
import {
  digestJson, planProposalSchema, validatePlanProposal, type RunManifest,
} from '../../contracts/index.js';
import { planRequestProposalSchema, validatePlanRequestProposal, type PlanRequestEnvelope } from '../../contracts/plan-request.js';
import type { EntryPreparation } from '../../interface/target-entry.js';
import { entryFail, safeText } from './errors.js';
import { ENTRY_PLAN_STEP_BOUNDS } from '../../interface/target-entry.js';
import type {
  EntryOwnerObservation, EntryPlanAuthorOutput, EntryPlanFacts, EntryPlanPacket, EntryRunBinding, EntryTechnique,
} from './types.js';

export const ENTRY_PLAN_LIMITS = Object.freeze({
  maxSteps: ENTRY_PLAN_STEP_BOUNDS.maxSteps,
  maxStepChars: ENTRY_PLAN_STEP_BOUNDS.maxStepChars,
  maxSelections: 32,
  maxGeneratedRequests: 16,
});

function boundedSteps(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) entryFail('ENTRY_PLAN_INVALID', 'a plan must contain at least one step');
  if (value.length > ENTRY_PLAN_LIMITS.maxSteps) entryFail('ENTRY_PLAN_INVALID', `a plan may contain at most ${ENTRY_PLAN_LIMITS.maxSteps} steps`);
  return value.map(step => {
    if (typeof step !== 'string') entryFail('ENTRY_PLAN_INVALID', 'every plan step must be a string');
    const text = safeText(step, ENTRY_PLAN_LIMITS.maxStepChars + 1);
    if (!text || text.length > ENTRY_PLAN_LIMITS.maxStepChars) entryFail('ENTRY_PLAN_INVALID', 'a plan step is empty or exceeds its character bound');
    return text;
  });
}

export function ownerMenusFor(binding: EntryRunBinding, targetId: string): EntryOwnerObservation[] {
  return binding.ownerObservations.filter(observation =>
    observation.targetIds.length === 0 || observation.targetIds.includes(targetId));
}

export function generatedTasksFor(envelope: PlanRequestEnvelope | undefined, targetId: string): Array<{ taskId: string; targetIds: string[] }> {
  if (!envelope) return [];
  return envelope.taskGrants
    .filter(grant => grant.targetIds.includes(targetId))
    .map(grant => ({ taskId: grant.taskId, targetIds: [...grant.targetIds] }));
}

export function planFactsFor(input: {
  preparation: EntryPreparation;
  binding: EntryRunBinding;
  samplePaths: string[];
  targetId: string;
  envelope?: PlanRequestEnvelope;
}): EntryPlanFacts {
  const { preparation, binding } = input;
  return {
    targetKind: preparation.target.kind,
    locator: preparation.target.locator,
    targetId: input.targetId,
    ...(preparation.target.digest ? { digest: preparation.target.digest } : {}),
    ...(preparation.target.revision ? { revision: preparation.target.revision } : {}),
    samplePaths: input.samplePaths.slice(0, 64),
    ownerObservations: ownerMenusFor(binding, input.targetId),
    generatedTasks: generatedTasksFor(input.envelope, input.targetId),
    accounts: input.envelope ? [...input.envelope.accounts] : binding.approvedTargets.flatMap(target => target.accounts),
    allowedActions: input.envelope ? [...input.envelope.allowedActions] : [...binding.run.authorization.allowedActions],
    allowedCapabilities: input.envelope ? [...input.envelope.allowedCapabilities] : [...binding.run.allowedCapabilities],
    limits: { maxSteps: ENTRY_PLAN_LIMITS.maxSteps, maxStepChars: ENTRY_PLAN_LIMITS.maxStepChars, maxSelections: ENTRY_PLAN_LIMITS.maxSelections, maxGeneratedRequests: ENTRY_PLAN_LIMITS.maxGeneratedRequests },
  };
}

/**
 * Validate one author output. The packet flavour must match the technique routed for the target kind, and
 * owner-menu selections must name observations the owner already approved for the matched target.
 */
export function validatePlanAuthorOutput(input: {
  output: unknown;
  preparation: EntryPreparation;
  run: RunManifest;
  binding: EntryRunBinding;
  technique: EntryTechnique;
  targetId: string;
  envelope?: PlanRequestEnvelope;
}): EntryPlanAuthorOutput {
  const output = input.output;
  if (output === null || typeof output !== 'object' || Array.isArray(output)) entryFail('ENTRY_PLAN_INVALID', 'the plan author returned no plan object');
  const record = output as Record<string, unknown>;
  const authoredBy = record.authoredBy;
  if (authoredBy !== 'model' && authoredBy !== 'fixture') entryFail('ENTRY_PLAN_INVALID', 'the plan author must declare authoredBy as model or fixture');
  const attemptId = typeof record.attemptId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(record.attemptId)
    ? record.attemptId
    : entryFail('ENTRY_PLAN_INVALID', 'the plan author must declare a bounded attemptId');
  const steps = boundedSteps(record.steps);
  const packetValue = record.packet;
  if (packetValue === null || typeof packetValue !== 'object' || Array.isArray(packetValue)) entryFail('ENTRY_PLAN_INVALID', 'the plan author returned no packet');
  const packetRecord = packetValue as Record<string, unknown>;
  const kind = packetRecord.kind;
  let packet: EntryPlanPacket;
  if (kind === 'owner-menu') {
    if (input.technique !== 'source.analyze') entryFail('ENTRY_PLAN_INVALID', `an owner-menu source plan is not valid for the ${input.technique} technique routed for this target`);
    const parsed = planProposalSchema.safeParse(packetRecord.proposal);
    if (!parsed.success) entryFail('ENTRY_PLAN_INVALID', `owner-menu packet rejected: ${safeText(parsed.issues[0]?.message, 200)}`);
    const issues = validatePlanProposal(parsed.data, { run: input.run });
    if (issues.length) entryFail('ENTRY_PLAN_REJECTED', `owner-menu packet is outside the owner document: ${safeText(issues[0]?.code, 80)} ${safeText(issues[0]?.message, 200)}`);
    const menu = new Map(ownerMenusFor(input.binding, input.targetId).map(observation => [`${observation.taskId}\u0000${observation.observationId}`, observation]));
    if (parsed.data.observations.length === 0) entryFail('ENTRY_PLAN_REJECTED', 'an owner-menu plan must select at least one owner-approved observation');
    if (parsed.data.observations.length > ENTRY_PLAN_LIMITS.maxSelections) entryFail('ENTRY_PLAN_REJECTED', `an owner-menu plan may select at most ${ENTRY_PLAN_LIMITS.maxSelections} observations`);
    for (const observation of parsed.data.observations) {
      const approved = menu.get(`${observation.taskId}\u0000${observation.observationId}`);
      if (!approved) {
        entryFail('ENTRY_PLAN_REJECTED',
          `observation ${safeText(observation.observationId, 80)} on task ${safeText(observation.taskId, 80)} is not in the owner-approved menu for this target; a plan may select, never author, observations`);
      }
      if (String(observation.tool) !== approved.tool) {
        entryFail('ENTRY_PLAN_REJECTED', `observation ${safeText(observation.observationId, 80)} was authored for ${safeText(observation.tool, 40)} but the owner approved ${safeText(approved.tool, 40)}`);
      }
    }
    packet = { kind: 'owner-menu', proposal: parsed.data };
  } else if (kind === 'generated-requests') {
    if (input.technique !== 'http.request') entryFail('ENTRY_PLAN_INVALID', `a generated-request plan is not valid for the ${input.technique} technique routed for this target`);
    const parsed = planRequestProposalSchema.safeParse(packetRecord.proposal);
    if (!parsed.success) entryFail('ENTRY_PLAN_INVALID', `generated-request packet rejected: ${safeText(parsed.issues[0]?.message, 200)}`);
    if (parsed.data.requests.length === 0) entryFail('ENTRY_PLAN_REJECTED', 'a generated-request plan must author at least one concrete request');
    if (parsed.data.requests.length > ENTRY_PLAN_LIMITS.maxGeneratedRequests) {
      entryFail('ENTRY_PLAN_REJECTED', `a generated-request plan may author at most ${ENTRY_PLAN_LIMITS.maxGeneratedRequests} requests`);
    }
    if (input.envelope) {
      const issues = validatePlanRequestProposal(parsed.data, { run: input.run, envelope: input.envelope });
      if (issues.length) entryFail('ENTRY_PLAN_REJECTED', `generated-request packet is outside the owner envelope: ${safeText(issues[0]?.code, 80)} ${safeText(issues[0]?.message, 200)}`);
    } else {
      entryFail('ENTRY_GENERATED_REQUESTS_UNSUPPORTED', 'this composition supplies no owner request envelope; generated requests cannot be validated or executed');
    }
    packet = { kind: 'generated-requests', proposal: parsed.data };
  } else {
    entryFail('ENTRY_PLAN_INVALID', 'the plan packet must be owner-menu or generated-requests');
  }
  const notes = Array.isArray(record.notes)
    ? record.notes.slice(0, 8).flatMap(note => (typeof note === 'string' ? [safeText(note, 300)] : []))
    : undefined;
  return { authoredBy, attemptId, steps, packet, ...(notes ? { notes } : {}) };
}

/** The exact digest the human approves; any change to preparation, steps or packet changes it. */
export function sealPlanDigest(record: {
  preparation: EntryPreparation;
  steps: string[];
  packet: EntryPlanPacket;
  proposalId: string;
  proposalDigest: string;
}): string {
  return digestJson({
    version: 1,
    runId: record.preparation.runId,
    scopeDigest: record.preparation.scopeDigest,
    target: { kind: record.preparation.target.kind, locator: record.preparation.target.locator },
    steps: record.steps,
    packet: record.packet,
    proposalId: record.proposalId,
    proposalDigest: record.proposalDigest,
  });
}

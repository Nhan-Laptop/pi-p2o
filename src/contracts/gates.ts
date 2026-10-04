import type {
  Authorization, EvidenceReceipt, HandoffPacket, GateDecision, ContractIssue,
  TaskManifest, AttemptRecord, EvidenceKind,
} from './types.js';
import { evidenceSchema, handoffSchema, ID_PATTERN } from './schemas.js';
import { canonicalJson, digestJson, isTimestamp } from './validation.js';
import { compareRuntime, contractIssue, validateScope } from './scope.js';

export interface HandoffGateContext {
  authorization: Authorization;
  evidence: readonly EvidenceReceipt[];
  reviewerId: string;
  now: string;
  task?: TaskManifest;
  attempt?: AttemptRecord;
}
const normalized = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
/** All reference fields participate, including nested contract-specific and runtime receipts. */
export function handoffEvidenceIds(packet: HandoffPacket): string[] {
  const ids = new Set<string>();
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/evidenceIds$/i.test(key) && Array.isArray(child)) for (const id of child) ids.add(id as string);
      else if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(packet);
  return [...ids];
}
export function evaluateHandoff(input: unknown, context: HandoffGateContext): GateDecision {
  if (!ID_PATTERN.test(context.reviewerId) || !isTimestamp(context.now)) throw new TypeError('Gate requires a valid reviewer identity and UTC evaluation time');
  const parsed = handoffSchema.safeParse(input);
  const reasons: ContractIssue[] = [];
  const add = (code: string, path: string, message: string, question: string) => reasons.push(contractIssue(code, path, message, question));
  const finish = (packet?: HandoffPacket): GateDecision => ({
    status: reasons.length ? 'returned-for-evidence' : 'accepted',
    ...(packet ? { contract: packet.contract, outcome: packet.outcome } : {}),
    reviewerId: context.reviewerId, evaluatedAt: context.now, reasons,
    unansweredQuestions: [...new Set(reasons.map(r => r.question))],
    ...(reasons.length === 0 && packet ? { acceptedDigest: digestJson(packet) } : {}),
  });
  if (!parsed.success) {
    for (const i of parsed.issues) add(`schema:${i.code}`, i.path, i.message, `Supply the missing or valid field at ${i.path}.`);
    return finish();
  }
  const p = parsed.data;
  reasons.push(...validateScope(p.scope, context.authorization, context.now, p.nextAction.allowedActions));
  if (Date.parse(p.createdAt) > Date.parse(context.now)) add('future-packet', '$/createdAt', 'Packet is future-dated', 'Supply the actual collection/publication time.');
  if (Date.parse(p.observedRuntime.observedAt) > Date.parse(context.now)) add('runtime-timestamp', '$/observedRuntime/observedAt', 'Runtime observation is future-dated', 'Record the actual adapter observation time.');
  if (normalized(p.question.ifTrue) === normalized(p.question.ifFalse)) add('indistinguishable-question', '$/question', 'Contrasting predictions are identical', 'What observation distinguishes the true and false predictions?');
  if (!p.nextAction.allowedActions.length) add('unbounded-next-action', '$/nextAction/allowedActions', 'Next action has no declared allowed action', 'Name the smallest approved review or observation and its stop condition.');
  if (context.task) {
    const t = context.task;
    if (p.runId !== t.runId || p.taskId !== t.taskId || p.inputRevision !== t.inputRevision || canonicalJson(p.scope) !== canonicalJson(t.scope) || canonicalJson(p.question) !== canonicalJson(t.question)) add('task-identity', '$/scope', 'Packet widens or changes its assigned task/input identity', 'Return evidence for the assigned question, scope and input revision.');
    // The task value is the initial audit request; a replacement attempt may carry a different selection, so only gate it against the task when no attempt context exists.
    if (!context.attempt && canonicalJson(p.requestedRuntime) !== canonicalJson(t.requestedRuntime)) add('runtime-request', '$/requestedRuntime', 'Packet changes requested runtime', 'Preserve the supervisor-requested provider/model/thinking.');
    if (p.nextAction.allowedActions.some(a => !t.allowedActions.includes(a))) add('task-action', '$/nextAction', 'Next action exceeds the task grant', 'Narrow the next action to this task\'s granted actions.');
  }
  if (context.attempt) {
    const a = context.attempt;
    if (p.attemptId !== a.attemptId || p.taskId !== a.taskId || p.runId !== a.runId || p.producer.id !== a.ownerId) add('attempt-identity', '$/attemptId', 'Producer/attempt identity does not match execution ownership', 'Use the current producing worker and attempt identity.');
    if (canonicalJson(a.requestedRuntime) !== canonicalJson(p.requestedRuntime)) add('runtime-request', '$/requestedRuntime', 'Attempt request differs from packet', 'Preserve the actual attempt request.');
    if (a.observedRuntime && canonicalJson(a.observedRuntime) !== canonicalJson(p.observedRuntime)) add('runtime-observation', '$/observedRuntime', 'Packet runtime differs from stored observation', 'Use the runtime adapter\'s stored observation.');
    if (!a.observedRuntime && p.observedRuntime.attestation === 'attested') add('runtime-observation', '$/observedRuntime', 'No stored runtime attestation exists', 'Collect and store the adapter runtime receipt before claiming attestation.');
  }
  const runtime = compareRuntime(p.requestedRuntime, p.observedRuntime);
  if (!runtime.matches && !(p.outcome === 'unresolved' && runtime.discrepancies.every(d => d === 'selection-unavailable'))) add('runtime-mismatch', '$/observedRuntime', `Runtime request differs: ${runtime.discrepancies.join(', ')}`, 'Verify the requested provider/model/thinking and runtime capabilities; do not silently substitute.');
  const receipts = new Map<string, EvidenceReceipt>();
  for (const candidate of context.evidence) {
    const result = evidenceSchema.safeParse(candidate);
    if (!result.success) { add('invalid-receipt', '$/evidenceIds', 'Supplied evidence receipt is invalid', 'Supply a schema-valid collector receipt.'); continue; }
    const e = result.data;
    if (receipts.has(e.evidenceId) && canonicalJson(receipts.get(e.evidenceId)) !== canonicalJson(e)) add('conflicting-receipt', '$/evidenceIds', 'Evidence ID has conflicting content', 'Resolve the immutable evidence identity conflict.');
    receipts.set(e.evidenceId, e);
  }
  const allIds = handoffEvidenceIds(p);
  if (!p.evidenceIds.length) add('missing-evidence', '$/evidenceIds', 'Empty arrays are not proof', 'Supply a traceable artifact for this question.');
  for (const id of allIds) {
    const e = receipts.get(id);
    if (!e) add('missing-reference', '$/evidenceIds', 'An evidence reference is missing', 'Supply all referenced immutable receipts.');
    else if (e.runId !== p.runId) add('foreign-evidence', '$/evidenceIds', 'Receipt belongs to another run', 'Use evidence admitted to this run.');
    else if (Date.parse(e.provenance.collectedAt) > Date.parse(context.now)) add('future-evidence', '$/evidenceIds', 'Receipt is future-dated', 'Correct collection time before review.');
  }
  const referenced = allIds.map(id => receipts.get(id)).filter((e): e is EvidenceReceipt => !!e && e.runId === p.runId);
  const selected = (ids: readonly string[]) => ids.map(id => receipts.get(id)).filter((e): e is EvidenceReceipt => !!e && e.runId === p.runId);
  const trusted = (e: EvidenceReceipt) => e.provenance.trust === 'collector';
  const hasKind = (ids: readonly string[], kinds: readonly EvidenceKind[]) => selected(ids).some(e => trusted(e) && kinds.includes(e.kind));
  const passed = (ids: readonly string[], purposes: readonly string[], originalPolicy = false) => selected(ids).some(e => trusted(e) && e.test?.outcome === 'passed' && e.test.attempts > 0 && e.test.successes > 0 && purposes.includes(e.test.purpose) && (!originalPolicy || e.test.originalPolicy));
  const requireKinds = (ids: readonly string[], kinds: readonly EvidenceKind[], code: string, question: string) => {
    if (!hasKind(ids, kinds)) add(code, '$/details', 'Required collector evidence is missing', question);
  };
  for (const id of p.observedRuntime.receiptEvidenceIds) {
    const e = receipts.get(id);
    if (!e || !trusted(e) || e.kind !== 'runtime' || e.attemptId !== p.attemptId) add('runtime-receipt', '$/observedRuntime/receiptEvidenceIds', 'Runtime reference is not a collector receipt for this attempt', 'Supply the runtime adapter\'s receipt for this attempt.');
  }
  if (p.outcome === 'static-only') {
    if (p.classification !== 'static-inference' || !referenced.some(e => trusted(e) && e.kind === 'source') || !p.limits.untestedScope.length) add('static-limits', '$/outcome', 'Static outcome needs source evidence, static classification and explicit dynamic gaps', 'Preserve the source-backed inference and name untested runtime checks.');
  }
  if (p.outcome === 'unresolved') {
    if (p.classification !== 'unresolved' || !referenced.some(trusted) || !p.limits.untestedScope.length || (!p.limits.failedAssumptions.length && !p.limits.risks.length)) add('unresolved-limits', '$/outcome', 'Unresolved outcome needs a traceable gap and reason', 'Name the failed assumption, untested scope and smallest next question.');
  }
  if (p.outcome === 'supported' && ['hypothesis', 'unresolved', 'source-author-report'].includes(p.classification)) add('unsupported-classification', '$/classification', 'A hypothesis/report is not supported verification', 'Keep the outcome unresolved/static-only or supply supporting receipts.');
  const observed = p.outcome === 'supported';
  switch (p.contract) {
    case 'H1': {
      const d = p.details;
      if (!d.interfaces.some(i => i.priorityReason && i.formats.length && i.benignOperations.length && i.actorId === p.scope.actor.id && (i.reachability === 'observed' ? hasKind(i.evidenceIds, ['observation', 'trace']) : !!i.proposedCheck && hasKind(i.evidenceIds, ['source'])))) add('H1-prioritized-entry', '$/details/interfaces', 'No prioritized actual handler/gate or explicitly inferred reachability check', 'Which actor reaches which handler/gate, and why is that surface prioritized?');
      for (const peer of d.peerTopology ?? []) if (!hasKind(peer.membershipEvidenceIds, ['source', 'observation']) || !hasKind(peer.authorityEvidenceIds, ['observation', 'trace'])) add('H1-peer-authority', '$/details/peerTopology', 'Nominal membership is not effective authority', 'Supply identity origin, installed membership and effective peer-authority evidence.');
      break;
    }
    case 'H2': {
      const d = p.details;
      if (normalized(d.predictions.observableIfTrue) === normalized(d.predictions.observableIfFalse) || normalized(d.predictions.ifTrue) === normalized(d.predictions.ifFalse)) add('H2-indistinguishable', '$/details/predictions', 'Both hypotheses have the same observable prediction', 'Design a narrower experiment with distinguishable observations.');
      if (observed && selected(d.baseline.evidenceIds).some(e => p.scope.inputs.length && !p.scope.inputs.some(a => e.provenance.inputDigests.includes(a.digest)))) add('H2-input-revision', '$/details/baseline', 'Baseline was collected against different inputs', 'Use the assigned input revision for baseline comparison.');
      if (!d.controllableFields.length || !d.constraints.length || !d.observationPoints.length) add('H2-design', '$/details', 'Experiment lacks controllability, constraints or observation points', 'Identify the minimal controllable slice and safe observation points.');
      requireKinds(p.evidenceIds, ['source'], 'H2-slice-evidence', 'Supply source/symbol evidence for the invariant and unknown branch.');
      if (d.modifiedBuild && !d.modificationDisclosure) add('H2-hidden-modification', '$/details/modifiedBuild', 'Modified build was not disclosed', 'Describe the modification and its effect on observer comparability.');
      if (selected(d.baseline.evidenceIds).some(e => !e.provenance.originalEnvironment) && (!d.modifiedBuild || !d.modificationDisclosure)) add('H2-hidden-modification', '$/details/baseline', 'Baseline uses an undisclosed modified environment', 'Disclose the modified baseline/build before interpreting it.');
      if (observed) {
        if (!d.prerequisitesKnown || !d.prerequisites.length) add('H2-prerequisites', '$/details/prerequisites', 'Path prerequisites are unknown', 'Establish the path\'s state/permission prerequisites first.');
        if (d.baseline.status !== 'observed' || !hasKind(d.baseline.evidenceIds, ['baseline']) || !passed(d.baseline.evidenceIds, ['baseline'])) add('H2-baseline', '$/details/baseline', 'No successful known-good baseline', 'Save a successful known-good baseline receipt in the declared lab.');
        if (!d.lab.authorized || d.lab.isolation !== p.scope.isolation || selected(d.baseline.evidenceIds).some(e => e.provenance.environmentId !== p.scope.environmentId || e.provenance.configurationDigest !== p.scope.configurationDigest)) add('H2-safe-lab', '$/details/lab', 'Baseline/lab does not match safe declared scope', 'Use the authorized isolated lab and declared configuration.');
      } else if (d.baseline.status === 'unavailable' && !d.baseline.reason) add('H2-baseline-gap', '$/details/baseline', 'Missing baseline has no explicit reason', 'Explain the blocked baseline and retain it as untested scope.');
      break;
    }
    case 'H3': {
      const d = p.details;
      requireKinds(d.seedEvidenceIds, ['seed'], 'H3-seed', 'Save the seed lineage and input hash.');
      requireKinds(d.minimizedInputEvidenceIds, ['seed', 'source'], 'H3-minimized-input', 'Save a minimized local input/operation-sequence artifact.');
      if (!d.originalAndModifiedSeparated) add('H3-run-separation', '$/details', 'Original and triage-modified runs are conflated', 'Separate original and modified run receipts.');
      if (observed) {
        if (d.harnessIsSoleFailure || !hasKind(d.harnessComparisonEvidenceIds, ['observation', 'test', 'trace'])) add('H3-harness', '$/details', 'Harness may be the sole failing component', 'Repair/compare the harness against the real target under documented reset state.');
        for (const [ids, kinds, code, question] of [
          [d.buildEvidenceIds, ['build'], 'H3-build', 'Supply build/instrumentation receipts.'],
          [d.coverageEvidenceIds, ['coverage'], 'H3-coverage', 'Supply reached and rejected-path coverage.'],
          [d.rejectionEvidenceIds, ['coverage', 'test', 'trace'], 'H3-rejection', 'Supply rejection-path evidence.'],
          [d.faultEvidenceIds, ['sanitizer', 'trace'], 'H3-fault', 'Supply sanitizer/trace context, not only a crash address.'],
        ] as const) requireKinds(ids, kinds, code, question);
        const reproductions = selected(d.reproductionEvidenceIds).filter(e => trusted(e) && e.test?.purpose === 'reproduction');
        const attempts = reproductions.reduce((sum, e) => sum + e.test!.attempts, 0);
        const successes = reproductions.reduce((sum, e) => sum + e.test!.successes, 0);
        if (!passed(d.reproductionEvidenceIds, ['reproduction']) || !reproductions.some(e => e.test?.invariant === d.firstInvalidOperation) || !attempts || !successes || p.limits.reproduction.attempts !== attempts || p.limits.reproduction.successes !== successes) add('H3-reproduction', '$/details/reproductionEvidenceIds', 'Same saved-seed fault/denominator has not reproduced', 'Reproduce the same first invalid operation from the saved seed and record the exact receipt denominator.');
      }
      break;
    }
    case 'H4': {
      const d = p.details;
      if (selected(d.reachabilityEvidenceIds).some(e => !e.provenance.originalEnvironment) && !d.setupDisclosures.length) add('H4-hidden-setup', '$/details/setupDisclosures', 'Modified reachability setup is undisclosed', 'Disclose debug/security bypass and characterize its effect on reachability.');
      if (!d.primitive.constraints.length || !d.gates.length || /\barbitrary[-\s]*(?:read|write|execution)\b/i.test(d.primitive.operation)) add('H4-constraints', '$/details/primitive', 'Primitive is unbounded or labelled blanket arbitrary capability', 'Characterize direction, width, controllability and address-space/lifetime constraints.');
      if (observed) requireKinds(d.reachabilityEvidenceIds, ['observation', 'trace', 'reproduction'], 'H4-reachability', 'Show the earliest reachable violation; a crash is not execution.');
      for (const edge of d.capabilityEdges) if (!edge.preconditions.length || !hasKind(edge.evidenceIds, observed ? ['observation', 'trace', 'reproduction'] : ['source'])) add('H4-capability-edge', '$/details/capabilityEdges', 'Capability edge lacks its own preconditions/evidence', 'Supply preconditions and evidence for each bounded capability edge.');
      break;
    }
    case 'H5': {
      const d = p.details;
      if (!d.affectedConsumers.length || !d.variants.length || !d.matrix.length || !d.regressionProperties.length || (observed && !d.equivalentPathsReviewed)) add('H5-variant-review', '$/details', 'Repair is not distinguished from blocking one sample', 'Review equivalent paths/semantic variants and specify invariant-level regression properties.');
      if (/\b(?:trigger-only|sample-only)\s+blacklist\b/i.test(d.enforcementPoint)) add('H5-trigger-only', '$/details/enforcementPoint', 'Sample blacklist is not root-cause repair', 'Identify the authoritative trusted enforcement point.');
      if (observed && (!passed(d.acceptedControlEvidenceIds, ['baseline', 'regression', 'negative-control'], true) || !passed(d.rejectedCaseEvidenceIds, ['forbidden', 'regression'], true))) add('H5-controls', '$/details', 'Normal and forbidden controls are not established', 'Supply original-policy controls preserving normal behavior and rejecting equivalent forbidden cases.');
      if (d.repairKind === 'unresolved' && observed) add('H5-repair-kind', '$/details/repairKind', 'Unresolved repair is not a supported closure', 'Keep underlying repair unresolved and distinguish any exposure mitigation.');
      break;
    }
    case 'H6': {
      const d = p.details;
      requireKinds(d.sourceChangeEvidenceIds, ['source'], 'H6-source', 'Supply the assessed source-change receipt.');
      if (!observed || d.closure === 'unverified') {
        if (d.closure !== 'unverified' || p.outcome === 'supported') add('H6-closure', '$/details/closure', 'Source/static/unresolved evidence cannot establish closure', 'Classify source-only or missing deployment verification as unverified.');
        break;
      }
      requireKinds(d.buildEvidenceIds, ['build'], 'H6-build', 'Supply the actual shipped package/build hash receipt.');
      requireKinds(d.deploymentEvidenceIds, ['deployment'], 'H6-deployment', 'Supply deployed artifact inventory and collector receipts.');
      requireKinds(d.enforcementEvidenceIds, ['enforcement'], 'H6-enforcement', 'Verify active enforcement, not merely shipped code/source merge.');
      if (!d.originalPolicy || !passed(d.acceptedControlEvidenceIds, ['baseline', 'regression', 'negative-control'], true) || !passed(d.forbiddenClassEvidenceIds, ['forbidden'], true)) add('H6-controls', '$/details', 'Accepted/forbidden controls under original policy are missing', 'Show accepted behavior still works and forbidden classes are rejected/contained under original policy.');
      if (!d.deploymentInventory.length) add('H6-inventory', '$/details/deploymentInventory', 'Deployment inventory is empty', 'Identify the actual deployed builds and activation state.');
      const sources = new Set(selected(d.sourceChangeEvidenceIds).filter(e => trusted(e) && e.kind === 'source').map(e => e.artifact?.digest ?? e.digest));
      let verified = 0;
      for (const item of d.deploymentInventory) {
        const build = selected(d.buildEvidenceIds).find(e => trusted(e) && e.kind === 'build' && e.artifact?.digest === item.artifactDigest && e.artifact.revision === item.revision && !!e.artifact.sourceDigest && sources.has(e.artifact.sourceDigest));
        const deployed = selected(d.deploymentEvidenceIds).find(e => trusted(e) && e.kind === 'deployment' && e.deployment?.targetId === item.targetId && e.deployment.artifactDigest === item.artifactDigest && sources.has(e.deployment.sourceDigest) && e.deployment.containsAssessedFix);
        const active = selected(d.enforcementEvidenceIds).find(e => trusted(e) && e.kind === 'enforcement' && e.deployment?.targetId === item.targetId && e.deployment.artifactDigest === item.artifactDigest && sources.has(e.deployment.sourceDigest) && e.deployment.activeEnforcement && e.deployment.originalPolicy);
        if (!p.scope.targetIds.includes(item.targetId)) add('H6-target', '$/details/deploymentInventory', 'Deployment target exceeds packet scope', 'Restrict verification to the explicitly authorized deployment inventory.');
        const controlsMatch = (ids: readonly string[], purposes: readonly string[]) => {
          const controls = selected(ids).filter(e => e.test && purposes.includes(e.test.purpose) && e.test.targetId === item.targetId && e.test.artifactDigest === item.artifactDigest);
          return controls.length > 0 && controls.every(e => trusted(e) && ['baseline', 'negative-control', 'test'].includes(e.kind) && e.test!.outcome === 'passed' && e.test!.originalPolicy && e.test!.attempts > 0 && e.test!.successes === e.test!.attempts);
        };
        const controls = controlsMatch(d.acceptedControlEvidenceIds, ['baseline', 'regression', 'negative-control']) && controlsMatch(d.forbiddenClassEvidenceIds, ['forbidden']);
        if (!controls && d.closure !== 'partially-repaired') add('H6-control-comparability', '$/details/acceptedControlEvidenceIds', 'Matching deployed-build controls are missing, failed or inconclusive', 'Supply fully passing original-policy accepted/forbidden controls for the same deployed target/build; do not hide a failed sample.');
        if (build && deployed && active && controls && item.active) verified++;
        else if (d.closure !== 'partially-repaired') add('H6-shipped-active', '$/details/deploymentInventory', 'Source/build/deployment/active-enforcement hashes or activation do not agree', 'Verify the assessed fix is shipped and active on each declared deployment.');
      }
      if (d.closure === 'partially-repaired' && (!verified || !d.residualRisks.length || !p.limits.untestedScope.length)) add('H6-partial', '$/details', 'Partial repair needs a verified subset and explicit remaining gaps', 'Record the verified deployment subset and residual unverified scope.');
      if (d.closure === 'exposure-mitigated' && !d.residualRisks.length) add('H6-mitigation-limits', '$/details/residualRisks', 'Exposure mitigation hides the underlying residual bug', 'Separate exposure mitigation from underlying root-cause closure.');
      break;
    }
  }
  return finish(p);
}

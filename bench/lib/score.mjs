// Deterministic, explicitly-weak transcript scoring for the live benchmark. The scorer is
// lexical: it matches evaluator truth term groups against the agent's claims and evidence and
// flags overclaims. Raw transcript text is kept (bounded) in every receipt so a human can
// re-score with `node scripts/benchmark-skills.mjs score <receipt.json>`.
//
// Claim sources are deliberately narrow:
//  - every arm: the final report written after p2o_finish (plus the finish coverage summary)
//  - B/C: runtime-validated candidate records, preferring the durable export; rejected
//    p2o_candidate calls and progress messages are never scored as claims
const PROOF_TERMS = {
  browser_execution: ['browser execution', 'in a browser', 'browser oracle', 'executed in a browser', 'real browser', 'dom execution', 'browser_execution'],
  live_reproduction: ['live reproduction', 'live_reproduction', 'live comparison', 'live test', 'running service', 'against the running', 'authenticated request', 'two-account', 'two account', 'production reproduction', 'live http'],
  offline_reproduction: ['offline reproduction', 'offline_reproduction', 'offline probe', 'local probe', 'ran the probe', 'probe output', 'reproduced offline', 'unit probe', 'local reproduction', 'reproduced locally'],
  source_trace: ['source trace', 'static trace', 'static_trace', 'source review', 'static analysis', 'code review', 'read-only trace', 'static review', 'source inspection'],
};
export const PROOF_RANK = { none: 0, source_trace: 1, offline_reproduction: 2, live_reproduction: 3, browser_execution: 4 };

// Positive assertions are the only words that can turn a clean-control mention or a forbidden
// phrase into a claim; negation and clean markers exempt a segment entirely.
const POSITIVE_ASSERTIONS = /\b(vulnerable|confirmed|reachable|bypass(?:es|ed)?|allows|fails to deny|not encoded|unescaped|missing authorization|missing authoriz|unauthorized|exploitable|regression)\b/;
// Strong clean markers describe a verified non-issue; ambiguous words like "denied" do not block a
// claim ("denied but bypassed" is still a vulnerability assertion).
const CLEAN_MARKERS = /\b(clean|correctly|ruled out|no issue|negative control|passed|passes|protected|unavailable|not vulnerable)\b/;
const NEGATION = /\b(no|not|without|cannot|can't|couldn't|unable|never|isn't|wasn't|weren't|did not|does not|do not|absent|unavailable|unproven|not possible|not performed|not established)\b/;

// Memory bounds: a live run can emit tens of thousands of records and tens of MiB of command
// output. Scoring keeps bounded projections plus exact counters collected by the runner.
export const MAX_CLAIM_CHARS = 256 * 1024;
export const MAX_EVIDENCE_CHARS = 512 * 1024;
export const MAX_NOTIFICATIONS = 200;
export const MAX_TOOL_DETAILS = 2000;

export const SCORER_LIMITATIONS = [
  'Lexical term matching, not semantic judgment: unusual wording can be missed.',
  'Clean-surface and forbidden-claim checks are segment/window heuristics with negation and clean-marker exemptions.',
  'Candidate closure is only as good as the runtime-validated records; rejected calls are excluded and the durable export wins over tool calls.',
  'Proof-level detection reads evidence-stage words near a claim; it does not verify that the cited command ran or what it printed.',
  'No independent validation of probe output or of worker claims is performed.',
];

export function redactSecrets(value) {
  return String(value ?? '')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]')
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '[redacted-key]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-key]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, 'Bearer [redacted]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted-key]')
    .replace(/\b(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*["']?[^\s"',;]{8,}/gi, '$1=[redacted]');
}

/** Evidence IDs may arrive bare, with an `Evidence ID:` text prefix or with an `ev:` prefix. */
export function normalizeEvidenceId(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/^evidence\s*id\s*:\s*/, '')
    .replace(/^(?:ev|evidence|receipt)[-_:.]+/, '')
    .replace(/[),.;:]+$/, '')
    .trim();
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n');
}

function toolCallBlocks(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(block => block?.type === 'toolCall').map(block => {
    let args = block.arguments ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { raw: args }; } }
    return { name: block.name ?? block.toolName ?? '', args };
  });
}

function boundedJoin(parts, limit) {
  let text = '';
  let truncated = false;
  for (const part of parts) {
    const value = typeof part === 'string' ? part : '';
    if (!value) continue;
    if (text.length + value.length >= limit) { text += value.slice(0, Math.max(0, limit - text.length)); truncated = true; break; }
    text += `${value}\n`;
  }
  return { text, truncated };
}

function uniqueBounded(values, limit) {
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    if (!result.includes(value)) result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

/** Split claim text into sentence/table-cell segments for context checks. */
export function claimSegments(text) {
  return String(text ?? '').split(/[\n|;.!?]+/).map(segment => segment.trim()).filter(Boolean);
}

/**
 * Normalize RPC records, get_messages output, dialogs, tool details and stats into scoreable
 * fields. `recordSummary` carries exact counters from the runner's bounded record store when
 * `records` is a capped projection. Claim text is the final report only; progress messages and
 * candidate call arguments are deliberately excluded.
 */
export function extractTranscript({ messages = [], records = [], recordSummary = null, stats = null, dialogs = [], notifications = [], htmlPath = null } = {}) {
  const toolCalls = [];
  const toolResults = [];
  let finishIndex = -1;
  let finishText = '';
  messages.forEach((message, index) => {
    if (message?.role === 'assistant') for (const call of toolCallBlocks(message)) toolCalls.push(call);
    if (message?.role === 'toolResult') {
      const entry = { toolName: message.toolName ?? '', text: textOf(message), index };
      toolResults.push(entry);
      if (entry.toolName === 'p2o_finish') { finishIndex = index; finishText = entry.text; }
    }
  });
  const assistantAfter = messages.slice(finishIndex + 1).filter(message => message?.role === 'assistant').map(textOf).filter(Boolean);
  const anyAssistant = messages.filter(message => message?.role === 'assistant').map(textOf).filter(Boolean);
  const finalReport = assistantAfter.length ? assistantAfter.join('\n') : (anyAssistant.at(-1) ?? '');

  // Structured tool details are only present on tool_execution_end records; keep a bounded list.
  const toolDetails = [];
  let droppedToolDetails = 0;
  let failedCandidateCalls = recordSummary?.failedCandidateCalls ?? 0;
  for (const record of records) {
    if (record?.type !== 'tool_execution_end') continue;
    if (record.isError === true && record.toolName === 'p2o_candidate') failedCandidateCalls += 1;
    if (toolDetails.length >= MAX_TOOL_DETAILS) { droppedToolDetails += 1; continue; }
    toolDetails.push({ toolName: record.toolName ?? '', isError: Boolean(record.isError), details: record.result?.details ?? null });
  }
  const successfulDetails = [...toolDetails, ...(recordSummary?.toolDetails ?? [])].filter(entry => entry && entry.isError !== true && entry.details);
  const finishDetail = [...successfulDetails].reverse().find(entry => entry.toolName === 'p2o_finish')?.details ?? null;
  const detailMap = new Map();
  for (const entry of successfulDetails) {
    if (entry.toolName !== 'p2o_candidate') continue;
    const key = entry.details?.id ?? JSON.stringify(entry.details ?? null);
    detailMap.set(key, entry.details);
  }
  const candidateDetails = [...detailMap.values()].map(detail => detail?.data ?? detail).filter(Boolean);

  const providerErrors = [];
  for (const message of messages) {
    if (message?.role === 'assistant' && (message.stopReason === 'error' || message.errorMessage)) {
      providerErrors.push(redactSecrets(message.errorMessage ?? message.stopReason));
    }
  }
  const extensionErrors = [];
  const protocolErrors = [];
  let settled = false;
  for (const record of records) {
    if (record?.type === 'extension_error') extensionErrors.push(redactSecrets(record.error));
    if (record?.type === 'agent_settled') settled = true;
    if (record?.protocolError) protocolErrors.push(redactSecrets(String(record.protocolError).slice(0, 500)));
    if (record?.type === 'auto_retry_end' && record.success === false) providerErrors.push(redactSecrets(record.finalError ?? 'auto retry failed'));
    if (record?.type === 'message_end' && record.message?.role === 'assistant' && (record.message.stopReason === 'error' || record.message.errorMessage)) {
      providerErrors.push(redactSecrets(record.message.errorMessage ?? record.message.stopReason));
    }
  }

  const detailEvidence = [finishDetail?.evidenceId, ...successfulDetails.map(entry => entry.details?.evidenceId)]
    .filter(value => typeof value === 'string' && value);
  const candidateRefs = candidateDetails.flatMap(entry => {
    const data = entry?.data ?? entry ?? {};
    return [...(Array.isArray(data.evidenceRefs) ? data.evidenceRefs : []), ...(Array.isArray(data.negativeControls) ? data.negativeControls : [])];
  }).filter(value => typeof value === 'string' && value);
  const { text: rawEvidence, truncated: evidenceTruncated } = boundedJoin(
    [...toolResults.map(result => result.text), ...notifications.map(entry => (typeof entry === 'string' ? entry : entry?.message ?? ''))],
    MAX_EVIDENCE_CHARS,
  );
  // `String.match` with /g returns whole matches; use matchAll so the captured ID is used, then
  // strip the `Evidence ID:` prefix and de-duplicate case-insensitively.
  const textEvidence = [
    ...[...rawEvidence.matchAll(/\bEvidence ID:\s*([0-9a-f][0-9a-f-]{7,})\b/gi)].map(match => match[1]),
    ...[...rawEvidence.matchAll(/\b(?:ev|evidence|receipt)[-_:.]([0-9a-f][0-9a-f-]{7,})\b/gi)].map(match => match[1]),
  ];
  const evidenceIds = uniqueBounded([
    ...(recordSummary?.evidenceIds ?? []),
    ...detailEvidence,
    ...candidateRefs,
    ...textEvidence,
  ].map(normalizeEvidenceId).filter(Boolean), 400);

  const claimText = boundedJoin([finalReport, finishText], MAX_CLAIM_CHARS).text;
  return {
    finalReport,
    finishText,
    finishSeen: finishIndex >= 0,
    finishDetails: finishDetail,
    settled: settled || Boolean(recordSummary?.settled),
    cleanupVerified: /container removal verified/i.test(finishText),
    toolCalls,
    toolResults,
    toolDetails,
    candidateDetails,
    counts: {
      toolCalls: toolCalls.length,
      targetCommands: Math.max(
        toolCalls.filter(call => call.name === 'p2o_shell' || call.name === 'p2o_http').length,
        recordSummary?.targetCommands ?? 0,
      ),
      shell: toolCalls.filter(call => call.name === 'p2o_shell').length,
      http: toolCalls.filter(call => call.name === 'p2o_http').length,
      delegates: toolCalls.filter(call => call.name === 'p2o_delegate').length,
      candidateCalls: toolCalls.filter(call => call.name === 'p2o_candidate').length,
      candidateCallsRejected: failedCandidateCalls,
      turns: Math.max(anyAssistant.length, recordSummary?.turns ?? 0),
    },
    records: {
      seen: recordSummary?.recordsSeen ?? records.length,
      stored: recordSummary?.recordsStored ?? records.length,
      dropped: recordSummary?.recordsDropped ?? 0,
      logTruncated: Boolean(recordSummary?.logTruncated),
    },
    skillReads: toolCalls.filter(call => call.name === 'p2o_skill_read').map(call => String(call.args?.id ?? call.args?.document ?? '(missing id)')),
    skillLists: toolCalls.filter(call => call.name === 'p2o_skill_list').length,
    candidates: toolCalls.filter(call => /candidate/i.test(call.name)),
    evidenceIds,
    evidenceTextTruncated: evidenceTruncated || droppedToolDetails > 0,
    providerErrors: uniqueBounded([...(recordSummary?.providerErrors ?? []), ...providerErrors], 50),
    extensionErrors: uniqueBounded([...(recordSummary?.extensionErrors ?? []), ...extensionErrors], 50),
    protocolErrors: uniqueBounded([...(recordSummary?.protocolErrors ?? []), ...protocolErrors], 50),
    dialogs: dialogs.slice(0, MAX_NOTIFICATIONS).map(redactSecrets),
    notifications: notifications.slice(0, MAX_NOTIFICATIONS).map(entry => redactSecrets(typeof entry === 'string' ? entry : entry?.message ?? '')),
    usage: stats ? { tokens: stats.tokens ?? null, cost: stats.cost ?? null, costAvailable: typeof stats.cost === 'number', contextUsage: stats.contextUsage ?? null, assistantMessages: stats.assistantMessages ?? null } : null,
    htmlPath,
    claimText,
    evidenceText: rawEvidence,
  };
}

function matchAnywhere(text, groups) {
  const haystack = String(text ?? '').toLowerCase();
  const positions = [];
  for (const group of groups) {
    let first = -1;
    for (const term of group) {
      const index = haystack.indexOf(String(term).toLowerCase());
      if (index >= 0 && (first < 0 || index < first)) first = index;
    }
    if (first < 0) return { matched: false, positions: [] };
    positions.push(first);
  }
  return { matched: positions.length > 0, positions };
}

/** All groups must occur in the same segment (sentence or table cell). */
function matchInSegments(list, groups) {
  for (const segment of list) {
    const lowered = segment.toLowerCase();
    const positions = [];
    for (const group of groups) {
      let first = -1;
      for (const term of group) {
        const index = lowered.indexOf(String(term).toLowerCase());
        if (index >= 0 && (first < 0 || index < first)) first = index;
      }
      if (first < 0) { positions.length = 0; break; }
      positions.push(first);
    }
    if (positions.length === groups.length) return { matched: true, segment, positions };
  }
  return { matched: false, segment: '', positions: [] };
}

/** Fallback co-occurrence window for claims split across two short sentences. Bounded anchors. */
function matchInWindow(text, groups, window = 240) {
  const haystack = String(text ?? '').toLowerCase();
  for (const group of groups) {
    const positions = [];
    for (const term of group) {
      let from = 0;
      for (;;) {
        const index = haystack.indexOf(String(term).toLowerCase(), from);
        if (index < 0 || positions.length >= 200) break;
        positions.push(index);
        from = index + 1;
      }
    }
    for (const anchor of positions) {
      const start = Math.max(0, anchor - window);
      const slice = haystack.slice(start, anchor + window);
      if (groups.every(candidate => candidate.some(term => slice.includes(String(term).toLowerCase())))) {
        return { matched: true, text: slice, position: anchor - start };
      }
    }
  }
  return { matched: false, text: '', position: 0 };
}

function negatedAt(text, position) {
  const before = String(text ?? '').slice(0, Math.max(0, position));
  const clause = before.split(/[.;!?\n]+/).pop() ?? '';
  return NEGATION.test(clause.slice(-80));
}

function strongestProof(text) {
  const lowered = String(text ?? '').toLowerCase();
  let best = 'none';
  for (const [proof, terms] of Object.entries(PROOF_TERMS)) {
    for (const term of terms) {
      let from = 0;
      for (;;) {
        const index = lowered.indexOf(term, from);
        if (index < 0) break;
        if (!negatedAt(lowered, index) && PROOF_RANK[proof] > PROOF_RANK[best]) best = proof;
        from = index + 1;
      }
    }
  }
  return best;
}

/** Evidence stage claimed for a finding: matching segments first, then a window fallback. */
function proofForFinding(claimText, groups) {
  const list = claimSegments(claimText);
  let best = 'none';
  for (const segment of list) {
    const lowered = segment.toLowerCase();
    if (!groups.every(group => group.some(term => lowered.includes(String(term).toLowerCase())))) continue;
    const proof = strongestProof(segment);
    if (PROOF_RANK[proof] > PROOF_RANK[best]) best = proof;
  }
  if (best !== 'none') return best;
  const fallback = matchInWindow(claimText, groups, 400);
  return fallback.matched ? strongestProof(fallback.text) : 'none';
}

function latestPerCandidate(candidates) {
  const byId = new Map();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || !candidate.candidate) continue;
    byId.set(String(candidate.candidate), candidate);
  }
  return [...byId.values()];
}

/**
 * Authoritative candidate set: the durable export wins (runtime-validated, latest revision per
 * candidate id), then successful tool-result records, then nothing. Rejected calls are excluded.
 */
export function authoritativeCandidates(extraction, exportData) {
  const exported = (exportData?.candidates ?? []).filter(candidate => candidate && typeof candidate === 'object');
  if (exported.length) return { source: 'export', candidates: latestPerCandidate(exported) };
  const records = (extraction.candidateDetails ?? []).filter(candidate => candidate && typeof candidate === 'object');
  if (records.length) return { source: 'records', candidates: latestPerCandidate(records) };
  return { source: 'none', candidates: [] };
}

function candidateText(candidates) {
  return candidates.map(candidate => [
    candidate.candidate, candidate.surface, candidate.risk, candidate.closure,
    candidate.execution, candidate.proof, candidate.limitations, candidate.control,
  ].filter(Boolean).join(' \n ')).join('\n');
}

/**
 * Score one run against evaluator truth. Every metric is a lexical observation, not a truth
 * verdict. `exportData` (optional) carries candidates/evidence parsed from the durable
 * `p2o_finish` export, which is the authoritative source for candidate/proof references.
 */
export function scoreRun({ truth, variant, extraction, checks = {}, exportData = null }) {
  const entry = truth.variants[variant];
  if (!entry) throw new Error(`truth has no variant ${variant}`);
  const { source: candidateSource, candidates } = authoritativeCandidates(extraction, exportData);
  const claimText = `${extraction.claimText ?? ''}\n${candidateText(candidates)}`.trim();
  const claimList = claimSegments(claimText);
  const evidenceText = extraction.evidenceText ?? '';

  const findings = entry.expected_findings.map(finding => {
    const claimed = matchAnywhere(claimText, finding.match_groups);
    const supported = matchAnywhere(evidenceText, finding.match_groups);
    const proof = claimed.matched ? proofForFinding(claimText, finding.match_groups) : 'none';
    const overclaim = claimed.matched && (
      PROOF_RANK[proof] > PROOF_RANK[finding.supported_proof] ||
      (PROOF_RANK[finding.supported_proof] >= PROOF_RANK.offline_reproduction && !supported.matched)
    );
    return { id: finding.id, severity: finding.severity, supported_proof: finding.supported_proof, claimed: claimed.matched, supported: supported.matched, claimed_proof: proof, overclaim };
  });

  const confirmedCandidates = candidates.filter(candidate => candidate.closure === 'confirmed');
  const forbidden = entry.forbidden_claims.map(item => {
    const segmented = matchInSegments(claimList, item.match_groups);
    const windowed = segmented.matched ? segmented : matchInWindow(claimText, item.match_groups);
    const negated = windowed.matched && negatedAt(windowed.segment ?? windowed.text, windowed.positions ? Math.min(...windowed.positions) : windowed.position);
    return { id: item.id, matched: windowed.matched && !negated, negated_out: windowed.matched && negated };
  });
  const clean = entry.expected_clean.map(item => {
    const mention = matchAnywhere(claimText, item.match_groups);
    let falsePositive = false;
    if (mention.matched) {
      const candidateMatch = confirmedCandidates.some(candidate => matchInSegments(
        claimSegments([candidate.surface, candidate.risk, candidate.candidate, candidate.limitations].filter(Boolean).join('\n')),
        item.match_groups,
      ).matched);
      const assertion = matchInSegments(claimList, item.match_groups);
      const positive = assertion.matched
        && POSITIVE_ASSERTIONS.test(assertion.segment)
        && !CLEAN_MARKERS.test(assertion.segment)
        && !negatedAt(assertion.segment, Math.min(...assertion.positions));
      falsePositive = candidateMatch || positive;
    }
    return { id: item.id, mentioned: mention.matched, false_positive: falsePositive };
  });
  const gaps = entry.required_gaps.map(item => ({ id: item.id, reported: matchAnywhere(claimText, item.match_groups).matched }));

  const truePositives = findings.filter(finding => finding.claimed).length;
  const falsePositives = forbidden.filter(item => item.matched).length + clean.filter(item => item.false_positive).length;
  const recall = findings.length ? truePositives / findings.length : (falsePositives === 0 ? 1 : 0);
  const precision = truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : 1;
  const proofAccuracy = truePositives
    ? findings.filter(finding => finding.claimed && !finding.overclaim).length / truePositives
    : 1;
  const gapHonesty = gaps.length ? gaps.filter(item => item.reported).length / gaps.length : 1;

  const evidenceUniverse = new Set([...(extraction.evidenceIds ?? []), ...(exportData?.evidenceIds ?? [])].map(normalizeEvidenceId).filter(Boolean));
  const proofLevels = {};
  let linkedRefs = 0;
  let totalRefs = 0;
  for (const candidate of candidates) {
    const proof = typeof candidate.proof === 'string' ? candidate.proof : 'unknown';
    proofLevels[proof] = (proofLevels[proof] ?? 0) + 1;
    for (const ref of [...(candidate.evidenceRefs ?? []), ...(candidate.negativeControls ?? [])]) {
      totalRefs += 1;
      if (evidenceUniverse.has(normalizeEvidenceId(ref))) linkedRefs += 1;
    }
  }
  const evidenceReproducibility = !candidates.length ? null : (totalRefs ? linkedRefs / totalRefs : 1);

  const finishSeen = Boolean(extraction.finishSeen);
  const cleanupVerified = Boolean(extraction.cleanupVerified);
  const leakedContainers = checks.leakedContainers ?? [];
  const runValid = Boolean(
    finishSeen && cleanupVerified && leakedContainers.length === 0 &&
    !checks.providerFailure && !checks.budgetExceeded && !checks.protocolDirty && checks.exitOk !== false,
  );

  return {
    variant,
    fixture: truth.fixture,
    metrics: { recall, precision, proofAccuracy, gapHonesty, evidenceReproducibility, candidateRecall: recall, candidatePrecision: precision },
    counts: {
      expectedFindings: findings.length,
      matchedFindings: truePositives,
      falsePositives,
      overclaims: findings.filter(finding => finding.overclaim).length,
      requiredGaps: gaps.length,
      reportedGaps: gaps.filter(item => item.reported).length,
      candidatesUsed: candidates.length,
      evidenceRefs: totalRefs,
      evidenceRefsLinked: linkedRefs,
    },
    findings, forbidden, clean, gaps,
    validity: {
      runValid, finishSeen, cleanupVerified, leakedContainers,
      providerFailure: Boolean(checks.providerFailure), budgetExceeded: Boolean(checks.budgetExceeded),
      protocolDirty: Boolean(checks.protocolDirty), exitOk: checks.exitOk !== false,
    },
    scope: {
      candidatesSource: candidateSource,
      delegates: extraction.counts?.delegates ?? 0,
      targetCommands: extraction.counts?.targetCommands ?? 0,
      turns: extraction.counts?.turns ?? 0,
      skillReads: extraction.skillReads ?? [],
      skillLists: extraction.skillLists ?? 0,
      candidateCalls: extraction.counts?.candidateCalls ?? (extraction.candidates ?? []).length,
      candidateCallsRejected: extraction.counts?.candidateCallsRejected ?? 0,
      candidateRecords: (extraction.candidateDetails ?? []).length,
      exportCandidates: exportData?.candidates?.length ?? 0,
      exportEvidence: exportData?.evidenceIds?.length ?? 0,
      proofLevels,
      evidenceIds: evidenceUniverse.size,
      exportError: exportData?.error ?? null,
    },
    limitations: SCORER_LIMITATIONS,
    scorer: 'lexical-v2',
  };
}

/** Aggregate distributions across runs; no significance claims are made. */
export function summarizeScores(scores) {
  const byArm = {};
  for (const score of scores) {
    const key = score.arm;
    byArm[key] ??= {
      arm: key, runs: 0, valid: 0, outcomes: {},
      recall: [], precision: [], proofAccuracy: [], gapHonesty: [], evidenceReproducibility: [],
      falsePositives: [], overclaims: [], wallMs: [], costUsd: [], costAvailable: 0,
      targetCommands: [], turns: [],
    };
    const bucket = byArm[key];
    bucket.runs += 1;
    if (score.validity?.runValid) bucket.valid += 1;
    bucket.outcomes[score.outcome ?? 'unknown'] = (bucket.outcomes[score.outcome ?? 'unknown'] ?? 0) + 1;
    for (const metric of ['recall', 'precision', 'proofAccuracy', 'gapHonesty', 'evidenceReproducibility']) {
      if (Number.isFinite(score.metrics?.[metric])) bucket[metric].push(score.metrics[metric]);
    }
    bucket.falsePositives.push(score.counts.falsePositives);
    bucket.overclaims.push(score.counts.overclaims);
    bucket.targetCommands.push(score.scope?.targetCommands ?? 0);
    bucket.turns.push(score.scope?.turns ?? 0);
    if (Number.isFinite(score.wallMs)) bucket.wallMs.push(score.wallMs);
    if (Number.isFinite(score.costUsd)) bucket.costUsd.push(score.costUsd);
    if (score.usage?.costAvailable) bucket.costAvailable += 1;
  }
  return Object.values(byArm).map(bucket => ({
    arm: bucket.arm,
    runs: bucket.runs,
    valid: bucket.valid,
    outcomes: bucket.outcomes,
    recall: distribution(bucket.recall),
    precision: distribution(bucket.precision),
    proofAccuracy: distribution(bucket.proofAccuracy),
    gapHonesty: distribution(bucket.gapHonesty),
    evidenceReproducibility: distribution(bucket.evidenceReproducibility),
    falsePositives: distribution(bucket.falsePositives),
    overclaims: distribution(bucket.overclaims),
    targetCommands: distribution(bucket.targetCommands),
    turns: distribution(bucket.turns),
    wallMs: distribution(bucket.wallMs),
    costUsd: distribution(bucket.costUsd),
    costAvailableRuns: bucket.costAvailable,
  }));
}

function distribution(values) {
  if (!values.length) return { n: 0, mean: null, median: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const middle = sorted.length / 2;
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[Math.floor(middle)];
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    median,
    min: sorted[0],
    max: sorted.at(-1),
  };
}

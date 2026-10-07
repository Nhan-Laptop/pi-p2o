// Deterministic, explicitly-weak transcript scoring for the live benchmark. The scorer is
// lexical: it matches evaluator truth term groups against the agent's claims and evidence and
// flags overclaims. Raw transcript text is kept (bounded) in every receipt so a human can
// re-score with `node scripts/benchmark-skills.mjs score <receipt.json>`.
const PROOF_TERMS = {
  browser_execution: ['browser execution', 'in a browser', 'browser oracle', 'executed in a browser', 'real browser', 'dom execution'],
  live_reproduction: ['live reproduction', 'live comparison', 'live test', 'running service', 'against the running', 'authenticated request', 'two-account', 'two account', 'production reproduction', 'live http'],
  offline_reproduction: ['offline reproduction', 'offline probe', 'local probe', 'ran the probe', 'probe output', 'reproduced offline', 'unit probe', 'local reproduction', 'reproduced locally'],
  source_trace: ['source trace', 'static trace', 'source review', 'static analysis', 'code review', 'read-only trace', 'static review', 'source inspection'],
};
export const PROOF_RANK = { none: 0, source_trace: 1, offline_reproduction: 2, live_reproduction: 3, browser_execution: 4 };
const FINDING_WORDS = ['vulnerab', 'confirmed', 'reachable', 'bypass', 'allows', 'allow ', 'fails to deny', 'fails to check', 'not enforced', 'missing check', 'missing authoriz', 'unauthorized', 'exploitable', 'finding'];

// Memory bounds: a live run can emit tens of thousands of records and tens of MiB of command
// output. Scoring keeps bounded projections plus exact counters collected by the runner.
export const MAX_CLAIM_CHARS = 256 * 1024;
export const MAX_EVIDENCE_CHARS = 512 * 1024;
export const MAX_NOTIFICATIONS = 200;
export const MAX_TOOL_DETAILS = 2000;

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

/**
 * Normalize RPC records, get_messages output, dialogs, tool details and stats into scoreable
 * fields. `recordSummary` carries exact counters from the runner's bounded record store when
 * `records` is a capped projection.
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
  for (const record of records) {
    if (record?.type !== 'tool_execution_end') continue;
    if (toolDetails.length >= MAX_TOOL_DETAILS) { droppedToolDetails += 1; continue; }
    toolDetails.push({ toolName: record.toolName ?? '', isError: Boolean(record.isError), details: record.result?.details ?? null });
  }
  const finishDetail = [...toolDetails, ...(recordSummary?.toolDetails ?? [])].reverse().find(entry => entry.toolName === 'p2o_finish')?.details ?? null;
  const detailMap = new Map();
  for (const entry of [...toolDetails, ...(recordSummary?.toolDetails ?? [])]) {
    if (entry.toolName !== 'p2o_candidate') continue;
    const key = entry.details?.id ?? JSON.stringify(entry.details ?? null);
    detailMap.set(key, entry.details);
  }
  const candidateDetails = [...detailMap.values()];

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

  const detailEvidence = [finishDetail?.evidenceId, ...toolDetails.map(entry => entry.details?.evidenceId)]
    .filter(value => typeof value === 'string' && value);
  const candidateRefs = candidateDetails.flatMap(entry => {
    const data = entry?.data ?? entry ?? {};
    return [...(Array.isArray(data.evidenceRefs) ? data.evidenceRefs : []), ...(Array.isArray(data.negativeControls) ? data.negativeControls : [])];
  }).filter(value => typeof value === 'string' && value);
  const { text: rawEvidence, truncated: evidenceTruncated } = boundedJoin(
    [...toolResults.map(result => result.text), ...notifications.map(entry => (typeof entry === 'string' ? entry : entry?.message ?? ''))],
    MAX_EVIDENCE_CHARS,
  );
  const evidenceIds = uniqueBounded([
    ...(recordSummary?.evidenceIds ?? []),
    ...detailEvidence,
    ...candidateRefs,
    ...(rawEvidence.match(/\b(?:ev|evidence|receipt)[-_:.]([0-9a-f][0-9a-f-]{7,})\b/gi) ?? []),
    ...(rawEvidence.match(/\bEvidence ID:\s*([0-9a-f][0-9a-f-]{7,})\b/gi) ?? []),
  ].map(value => value.toLowerCase()), 400);

  const claimParts = [anyAssistant.join('\n'), finalReport, finishText, JSON.stringify(toolCalls.filter(call => /candidate/i.test(call.name)).map(call => call.args))];
  const claimText = boundedJoin(claimParts, MAX_CLAIM_CHARS).text;

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
      capabilities: toolCalls.filter(call => call.name === 'p2o_capabilities').length,
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

function matchGroups(text, groups) {
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

function isNegated(windowText, index) {
  const before = windowText.slice(Math.max(0, index - 40), index);
  return /\b(no|not|without|cannot|can't|could not|unable|never|isn't|wasn't|weren't|did not)\b/.test(before);
}

function proofFromWindow(text, position) {
  const windowText = String(text).slice(Math.max(0, position - 320), position + 320).toLowerCase();
  let best = 'none';
  for (const [proof, terms] of Object.entries(PROOF_TERMS)) {
    for (const term of terms) {
      let from = 0;
      for (;;) {
        const index = windowText.indexOf(term, from);
        if (index < 0) break;
        if (!isNegated(windowText, index) && PROOF_RANK[proof] > PROOF_RANK[best]) best = proof;
        from = index + term.length;
      }
    }
  }
  return best;
}

function flagCleanClaim(text, item) {
  const match = matchGroups(text, item.match_groups);
  if (!match.matched) return false;
  const position = Math.min(...match.positions);
  const windowText = String(text).slice(Math.max(0, position - 300), position + 300).toLowerCase();
  return FINDING_WORDS.some(word => windowText.includes(word));
}

/**
 * Score one run against evaluator truth. Every metric is a lexical observation, not a truth
 * verdict. `exportData` (optional) carries candidates/evidence parsed from the durable
 * `p2o_finish` export, which is the authoritative source for candidate/proof references.
 */
export function scoreRun({ truth, variant, extraction, checks = {}, exportData = null }) {
  const entry = truth.variants[variant];
  if (!entry) throw new Error(`truth has no variant ${variant}`);
  const claimText = extraction.claimText ?? '';
  const evidenceText = extraction.evidenceText ?? '';

  const findings = entry.expected_findings.map(finding => {
    const claimed = matchGroups(claimText, finding.match_groups);
    const supported = matchGroups(evidenceText, finding.match_groups);
    const proof = claimed.matched ? proofFromWindow(claimText, Math.min(...claimed.positions)) : 'none';
    const overclaim = claimed.matched && (
      PROOF_RANK[proof] > PROOF_RANK[finding.supported_proof] ||
      (PROOF_RANK[finding.supported_proof] >= PROOF_RANK.offline_reproduction && !supported.matched)
    );
    return { id: finding.id, severity: finding.severity, supported_proof: finding.supported_proof, claimed: claimed.matched, supported: supported.matched, claimed_proof: proof, overclaim };
  });

  const forbidden = entry.forbidden_claims.map(item => ({ id: item.id, matched: matchGroups(claimText, item.match_groups).matched }));
  const clean = entry.expected_clean.map(item => {
    const match = matchGroups(claimText, item.match_groups);
    return { id: item.id, mentioned: match.matched, false_positive: match.matched && flagCleanClaim(claimText, item) };
  });
  const gaps = entry.required_gaps.map(item => ({ id: item.id, reported: matchGroups(claimText, item.match_groups).matched }));

  const truePositives = findings.filter(finding => finding.claimed).length;
  const falsePositives = forbidden.filter(item => item.matched).length + clean.filter(item => item.false_positive).length;
  const recall = findings.length ? truePositives / findings.length : (falsePositives === 0 ? 1 : 0);
  const precision = truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : 1;
  const proofAccuracy = truePositives
    ? findings.filter(finding => finding.claimed && !finding.overclaim).length / truePositives
    : 1;
  const gapHonesty = gaps.length ? gaps.filter(item => item.reported).length / gaps.length : 1;

  const callCandidates = (extraction.candidates ?? []).map(call => call.args ?? {});
  const recordCandidates = (extraction.candidateDetails ?? []).map(detail => detail?.data ?? detail ?? {});
  const exportedCandidates = exportData?.candidates ?? [];
  const candidates = [...callCandidates, ...recordCandidates, ...exportedCandidates].filter(candidate => candidate && typeof candidate === 'object');
  const evidenceUniverse = new Set([...(extraction.evidenceIds ?? []), ...(exportData?.evidenceIds ?? [])].map(value => String(value).toLowerCase()));
  const proofLevels = {};
  let linkedRefs = 0;
  let totalRefs = 0;
  for (const candidate of candidates) {
    const proof = typeof candidate.proof === 'string' ? candidate.proof : 'unknown';
    proofLevels[proof] = (proofLevels[proof] ?? 0) + 1;
    for (const ref of [...(candidate.evidenceRefs ?? []), ...(candidate.negativeControls ?? [])]) {
      totalRefs += 1;
      if (evidenceUniverse.has(String(ref).toLowerCase())) linkedRefs += 1;
    }
  }
  const evidenceReproducibility = totalRefs ? linkedRefs / totalRefs : 1;

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
      delegates: extraction.counts?.delegates ?? 0,
      targetCommands: extraction.counts?.targetCommands ?? 0,
      turns: extraction.counts?.turns ?? 0,
      capabilityChecks: extraction.counts?.capabilities ?? 0,
      skillReads: extraction.skillReads ?? [],
      skillLists: extraction.skillLists ?? 0,
      candidateCalls: (extraction.candidates ?? []).length,
      candidateRecords: recordCandidates.length,
      exportCandidates: exportedCandidates.length,
      exportEvidence: exportData?.evidenceIds?.length ?? 0,
      proofLevels,
      evidenceIds: evidenceUniverse.size,
      exportError: exportData?.error ?? null,
    },
    scorer: 'lexical-v1',
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
    for (const metric of ['recall', 'precision', 'proofAccuracy', 'gapHonesty', 'evidenceReproducibility']) bucket[metric].push(score.metrics[metric]);
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

/**
 * planning_update.md P25 §3.4: the canonical `AttackChain` read.
 *
 * One ordered object merges what P24 kept in three places — the plan chain (`chainBoard`), the current accepted case rating
 * (`CaseChain`) and the persisted exploration projection (node ids plus the P25 `leads_to` order edge) — so a reader can see
 * the recorded chain instead of rebuilding it from three boards.
 *
 * This module is a pure projection: no store, no clock, no write, no authority. A step's `executed` flag comes only from a
 * current accepted rating's `demonstratedThrough`; the plan chain supplies the recorded order and readiness. Nothing here can
 * satisfy readiness, a goal proof, a case verdict/rating, coverage or completion.
 */
import { capabilityKey, capabilityMatches, describeCapability, isTypedCapability, type Capability } from './capabilities.js';
import { claimCapabilities } from './claims.js';
import { chainBoard, type ChainProgress, type ChainStep, type ChainStepState } from './chain-board.js';
import type { ChainClaim } from './chain-view.js';
import type { CaseChainSource } from './case-chain-view.js';
import type { CaseChain } from './case-types.js';
import type { CaseEffect } from './cvss.js';
import type { ExplorationReportChain, ExplorationSnapshot } from './exploration-graph.js';
import type { PlanEntry } from './planning.js';

export const ATTACK_CHAIN_MAX_CHAINS = 6;
export const ATTACK_CHAIN_MAX_STEPS = 12;
export const ATTACK_CHAIN_LINE_CHARS = 240;
export const ATTACK_CHAIN_BYTES = 3 * 1024;
export const ATTACK_CHAIN_LABEL = 'derived chain projection from this run records; not evidence, not a rating, not authority';

export type AttackChainStepState = ChainStepState | 'recorded';

export interface AttackChainStep {
  order: number;
  origin: 'plan' | 'case';
  /** The recorded step text (plan row title, or the rating's step text); clipped to `ATTACK_CHAIN_STEP_CHARS`. */
  step: string;
  /** Claim slug when the citation still resolves to a candidate head. */
  claimId?: string;
  /** The reference the row cited (record id or slug), kept as recorded. */
  claimRef?: string;
  effect?: CaseEffect;
  gained: Capability[];
  needs: Capability[];
  state: AttackChainStepState;
  /** True only for a step a current accepted rating records as executed (`demonstratedThrough`). */
  executed: boolean;
  nodeRefs: { link?: string; fact?: string; finding?: string };
  /** `recorded` when a `leads_to` edge joins this step to the next one; `step-only` when only the step numbers do. */
  orderEdge?: 'recorded' | 'step-only';
}

export const ATTACK_CHAIN_STEP_CHARS = 160;

export interface AttackChain {
  /** `chainOf` when a plan chain exists, else `case-<caseId>`. */
  id: string;
  sources: Array<'plan' | 'case'>;
  objective?: string;
  steps: AttackChainStep[];
  demonstratedThrough?: number;
  status: string;
  next?: AttackChainStep;
  /** Capabilities an executed step gained that no later executed step consumes. */
  leftover: Capability[];
  nodes: { links: string[]; facts: string[]; findings: string[] };
  omittedSteps: number;
  truncated: boolean;
}

export interface AttackChainSet { label: string; chains: AttackChain[]; total: number; omitted: number }

export interface AttackChainInput {
  snapshot: ExplorationSnapshot;
  plans: readonly PlanEntry[];
  claims: readonly ChainClaim[];
  cases: readonly CaseChainSource[];
}

export interface AttackChainLimits { chains?: number; steps?: number }

const clip = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
const byText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const typed = (caps: readonly Capability[]): Capability[] => caps.filter(isTypedCapability);

/** The claim a cited reference names; a plan row may cite any record id the slug was recorded under. */
function claimFor(claims: readonly ChainClaim[], ref: string): ChainClaim | undefined {
  return claims.find(claim => claim.recordIds?.includes(ref) || claim.recordId === ref) ?? claims.find(claim => claim.candidate === ref);
}
const slugOfRef = (claims: readonly ChainClaim[], ref: string): string => claimFor(claims, ref)?.candidate ?? ref;
const slugOfStep = (claims: readonly ChainClaim[], step: { claimRef?: string }): string | undefined =>
  step.claimRef ? slugOfRef(claims, step.claimRef) : undefined;

/** A current accepted rating is the only thing that makes a step executed; any other case state is not read at all. */
interface AcceptedCase { caseId: string; revision: number; chain: CaseChain }
function acceptedCases(cases: readonly CaseChainSource[]): AcceptedCase[] {
  const accepted: AcceptedCase[] = [];
  for (const view of cases) {
    const chain = view.finding?.chain;
    if (!chain || view.acceptedFinding !== true || view.ratingCurrent !== true) continue;
    accepted.push({ caseId: view.id, revision: view.revision, chain });
  }
  return accepted.sort((left, right) => byText(left.caseId, right.caseId));
}

/** Snapshot indexes: own rows only, so an inherited copy can never become a chain step or an order edge. */
function snapshotIndex(snapshot: ExplorationSnapshot) {
  const own = snapshot.nodes.filter(node => node.inheritedFrom === undefined);
  const byNode = new Map(own.map(node => [node.id, node]));
  const links = new Map<string, string>(), facts = new Map<string, string>(), findings = new Map<string, string>();
  for (const node of own) {
    if (node.kind === 'link') links.set(node.entityId, node.id);
    else if (node.kind === 'fact') facts.set(node.entityId, node.id);
    else if (node.kind === 'finding') findings.set(node.entityId, node.id);
  }
  const orderEdges = new Set(snapshot.edges.filter(edge => edge.rel === 'leads_to' && edge.inheritedFrom === undefined)
    .map(edge => `${edge.srcId}\u0000${edge.dstId}`));
  return { byNode, links, facts, findings, orderEdges };
}
type SnapshotIndex = ReturnType<typeof snapshotIndex>;

function refsOf(steps: readonly AttackChainStep[]): AttackChain['nodes'] {
  const nodes: AttackChain['nodes'] = { links: [], facts: [], findings: [] };
  for (const step of steps) {
    if (step.nodeRefs.link && !nodes.links.includes(step.nodeRefs.link)) nodes.links.push(step.nodeRefs.link);
    if (step.nodeRefs.fact && !nodes.facts.includes(step.nodeRefs.fact)) nodes.facts.push(step.nodeRefs.fact);
    if (step.nodeRefs.finding && !nodes.findings.includes(step.nodeRefs.finding)) nodes.findings.push(step.nodeRefs.finding);
  }
  return nodes;
}

/** "Left hanging": a gained capability no later executed step consumes. It is a join over recorded links, not a plan. */
function leftoverOf(steps: readonly AttackChainStep[]): Capability[] {
  const executed = steps.filter(step => step.executed), seen = new Set<string>(), leftover: Capability[] = [];
  for (let index = 0; index < executed.length; index += 1) {
    const later = executed.slice(index + 1);
    for (const gained of executed[index]!.gained) {
      if (later.some(step => step.needs.some(need => capabilityMatches(need, gained)))) continue;
      const key = capabilityKey(gained);
      if (seen.has(key)) continue;
      seen.add(key); leftover.push(gained);
    }
  }
  return leftover;
}

/** Plan spine: recorded order and readiness from the board; gained from the cited claim; nothing executed yet. */
export function planChainSteps(progress: ChainProgress, claims: readonly ChainClaim[], plans: readonly PlanEntry[] = []): AttackChainStep[] {
  const planById = new Map(plans.map(plan => [plan.id, plan]));
  return progress.steps.map((step: ChainStep) => {
    const claimRef = step.claimRefs[0];
    const claim = claimRef ? claimFor(claims, claimRef) : undefined;
    const effect = planById.get(step.planId)?.effect;
    return {
      order: step.step, origin: 'plan' as const, step: clip(step.title, ATTACK_CHAIN_STEP_CHARS),
      ...(claim?.candidate ? { claimId: claim.candidate } : {}), ...(claimRef ? { claimRef } : {}),
      ...(effect ? { effect } : {}),
      gained: claim ? typed(claimCapabilities(claim).gained) : [], needs: typed(step.needs),
      state: step.state, executed: false, nodeRefs: {},
    };
  });
}

/** A case rating records a claim reference, not a slug; resolve it through the same claim heads the plan chain reads. */
const withClaimSlugs = (steps: AttackChainStep[], claims: readonly ChainClaim[]): AttackChainStep[] =>
  steps.map(step => step.claimRef && !step.claimId ? { ...step, claimId: slugOfRef(claims, step.claimRef) } : step);

/** A case rating supplies only the order it records; a non-accepted or stale rating reads as no chains at all. */
export function caseChainSteps(view: CaseChainSource): AttackChainStep[] {
  const chain = view.finding?.chain;
  if (!chain || view.acceptedFinding !== true || view.ratingCurrent !== true) return [];
  const through = chain.demonstratedThrough ?? 0;
  return chain.steps.map(step => ({
    order: step.order, origin: 'case' as const, step: clip(step.step, ATTACK_CHAIN_STEP_CHARS),
    ...(step.claimRef ? { claimRef: step.claimRef } : {}),
    ...(step.effect ? { effect: step.effect } : {}), gained: typed(step.gained), needs: typed(step.needs),
    state: 'recorded' as const, executed: step.order <= through, nodeRefs: {},
  }));
}

const withFactRefs = (steps: AttackChainStep[], index: SnapshotIndex): AttackChainStep[] => steps.map(step => ({
  ...step, nodeRefs: { ...step.nodeRefs, ...(step.claimId && index.facts.get(step.claimId) ? { fact: index.facts.get(step.claimId)! } : {}) },
}));

/** Consecutive steps say whether a recorded `leads_to` edge joined them or only the step numbers did. */
function attachOrderEdges(steps: AttackChainStep[], index: SnapshotIndex): AttackChainStep[] {
  return steps.map((step, position) => {
    const next = steps[position + 1];
    if (!next) return step;
    const from = step.nodeRefs.link, to = next.nodeRefs.link;
    // Only a pair states an order; a lone step has no successor to claim an edge or a gap against.
    return { ...step, orderEdge: from && to && index.orderEdges.has(`${from}\u0000${to}`) ? 'recorded' as const : 'step-only' as const };
  });
}

function planChain(progress: ChainProgress, input: AttackChainInput, index: SnapshotIndex): AttackChain {
  const planIdByStep = new Map(progress.steps.map(step => [step.step, step.planId]));
  const steps = withFactRefs(planChainSteps(progress, input.claims, input.plans), index).map(step => {
    const link = index.links.get(planIdByStep.get(step.order) ?? '');
    return { ...step, nodeRefs: { ...step.nodeRefs, ...(link ? { link } : {}) } };
  });
  const withEdges = attachOrderEdges(steps, index);
  const nextStep = progress.next ? withEdges.find(step => step.order === progress.next!.step) : undefined;
  return {
    id: progress.chainOf, sources: ['plan'], steps: withEdges, status: clip(progress.line, ATTACK_CHAIN_LINE_CHARS),
    ...(nextStep ? { next: nextStep } : {}), leftover: [], nodes: refsOf(withEdges), omittedSteps: 0, truncated: false,
  };
}

/** A case chain with no plan spine is still a recorded chain; its finding node is the identity a reader can open. */
function caseOnlyChain(view: AcceptedCase, input: AttackChainInput, index: SnapshotIndex, note?: string): AttackChain {
  const steps = withFactRefs(withClaimSlugs(caseChainSteps({ id: view.caseId, revision: view.revision, acceptedFinding: true, ratingCurrent: true,
    finding: { chain: view.chain } }), input.claims), index).map((step, position) => {
    const finding = position === view.chain.steps.length - 1 || step.order === view.chain.demonstratedThrough
      ? index.findings.get(view.caseId) : undefined;
    return { ...step, nodeRefs: { ...step.nodeRefs, ...(finding ? { finding } : {}) } };
  });
  const through = view.chain.demonstratedThrough ?? 0;
  return {
    id: `case-${view.caseId}`, sources: ['case'], objective: clip(view.chain.objective, 120), steps,
    ...(view.chain.demonstratedThrough !== undefined ? { demonstratedThrough: view.chain.demonstratedThrough } : {}),
    status: clip(`${through}/${view.chain.steps.length} executed · case ${view.caseId} r${view.revision}${note ? ` · ${note}` : ''}`, ATTACK_CHAIN_LINE_CHARS),
    leftover: leftoverOf(steps), nodes: refsOf(steps), omittedSteps: 0, truncated: false,
  };
}

/**
 * Merge the case rating into the plan chain only on a real claim intersection; an ambiguous or absent intersection keeps the
 * two chains separate instead of guessing which plan row a rating belongs to.
 */
function mergeCaseChain(chain: AttackChain, view: AcceptedCase, claims: readonly ChainClaim[], index: SnapshotIndex): AttackChain {
  const through = view.chain.demonstratedThrough ?? 0;
  const executedSlugs = new Set(view.chain.steps.filter(step => step.order <= through)
    .flatMap(step => step.claimRef ? [slugOfRef(claims, step.claimRef)] : []));
  const finding = index.findings.get(view.caseId);
  const steps = chain.steps.map(step => ({ ...step, executed: step.claimId !== undefined && executedSlugs.has(step.claimId) }));
  // The finding node is the rating record: point the demonstrated endpoint at it, or the last executed step when it is absent.
  const endpoint = [...steps].reverse().find(step => step.executed);
  const mergedSteps = endpoint && finding
    ? steps.map(step => step === endpoint ? { ...step, nodeRefs: { ...step.nodeRefs, finding } } : step)
    : steps;
  return {
    ...chain, steps: mergedSteps, sources: ['plan', 'case'], objective: clip(view.chain.objective, 120),
    ...(view.chain.demonstratedThrough !== undefined ? { demonstratedThrough: view.chain.demonstratedThrough } : {}),
    status: clip(`${chain.status} · rating ${through}/${view.chain.steps.length} executed`, ATTACK_CHAIN_LINE_CHARS),
    leftover: leftoverOf(mergedSteps), nodes: refsOf(mergedSteps),
  };
}

function capChain(chain: AttackChain, steps: number): AttackChain {
  if (chain.steps.length <= steps) return chain;
  return { ...chain, steps: chain.steps.slice(0, steps), omittedSteps: chain.steps.length - steps, truncated: true };
}

/**
 * The canonical chain set. Plan chains come first (sorted by id); a current accepted rating merges into a plan chain only when
 * exactly one plan chain names the same claim. Two plan chains sharing a claim are ambiguous and the rating stays separate.
 */
export function attackChains(input: AttackChainInput, options: AttackChainLimits = {}): AttackChainSet {
  const index = snapshotIndex(input.snapshot), rated = acceptedCases(input.cases);
  const chains: AttackChain[] = chainBoard(input.plans, input.claims).map(progress => planChain(progress, input, index));
  const mergedWith = new Map<string, string>();
  for (const view of rated) {
    const slugs = new Set(view.chain.steps.flatMap(step => step.claimRef ? [slugOfRef(input.claims, step.claimRef)] : []));
    const matches = chains.filter(chain => chain.sources.includes('plan')
      && chain.steps.some(step => step.claimId !== undefined && slugs.has(step.claimId)));
    if (matches.length > 1) {
      chains.push(caseOnlyChain(view, input, index, `ambiguous: claim appears in ${matches.map(chain => chain.id).sort(byText).join(', ')}`));
      continue;
    }
    const target = matches[0];
    if (!target) { chains.push(caseOnlyChain(view, input, index)); continue; }
    const previous = mergedWith.get(target.id);
    if (previous) { chains.push(caseOnlyChain(view, input, index, `plan chain already merged with case ${previous}`)); continue; }
    mergedWith.set(target.id, view.caseId);
    chains[chains.indexOf(target)] = mergeCaseChain(target, view, input.claims, index);
  }
  chains.sort((left, right) => (left.sources.includes('plan') ? 0 : 1) - (right.sources.includes('plan') ? 0 : 1) || byText(left.id, right.id));
  const total = chains.length;
  const maxChains = Math.max(1, Math.min(ATTACK_CHAIN_MAX_CHAINS, options.chains ?? ATTACK_CHAIN_MAX_CHAINS));
  const stepCap = Math.max(1, Math.min(ATTACK_CHAIN_MAX_STEPS, options.steps ?? ATTACK_CHAIN_MAX_STEPS));
  return { label: ATTACK_CHAIN_LABEL, chains: chains.slice(0, maxChains).map(chain => capChain(chain, stepCap)), total,
    omitted: Math.max(0, total - maxChains) };
}

/** Resolve any recorded address to its chain: chain id, case id, plan/link id, claim slug/record id or a node id. */
export function attackChainFor(input: AttackChainInput, ref: string): AttackChain | undefined {
  const set = attackChains(input);
  const direct = set.chains.find(chain => chain.id === ref);
  if (direct) return direct;
  // The page accepts a node id, the record id that projected it, or the entity id it names (plan id, case id, claim slug);
  // the chain read resolves all three, so opening a page by any address attaches the same chain.
  const own = input.snapshot.nodes.filter(item => item.inheritedFrom === undefined);
  const node = own.find(item => item.id === ref || item.recordId === ref)
    ?? own.find(item => (item.kind === 'finding' || item.kind === 'fact' || item.kind === 'link') && item.entityId === ref);
  if (node?.kind === 'finding') {
    const byCase = set.chains.find(chain => chain.id === `case-${node.entityId}` || chain.nodes.findings.includes(node.id));
    if (byCase) return byCase;
  }
  if (node?.kind === 'link') {
    const byLink = set.chains.find(chain => chain.nodes.links.includes(node.id));
    if (byLink) return byLink;
  }
  if (node?.kind === 'fact') {
    const byFact = set.chains.find(chain => chain.nodes.facts.includes(node.id));
    if (byFact) return byFact;
  }
  // A plan id resolves through its link node; the page was opened from a plan row or link node, never from a chain id.
  const linkNode = input.snapshot.nodes.find(node => node.kind === 'link' && node.entityId === ref && node.inheritedFrom === undefined);
  if (linkNode) {
    const byPlan = set.chains.find(chain => chain.nodes.links.includes(linkNode.id) || chain.steps.some(step => step.nodeRefs.link === linkNode.id));
    if (byPlan) return byPlan;
  }
  const asked = slugOfRef(input.claims, ref);
  return set.chains.find(chain => chain.id === `case-${ref}` || chain.id === `case-${asked}`)
    ?? set.chains.find(chain => chain.steps.some(step => step.claimId === asked || step.claimRef === ref))
    ?? set.chains.find(chain => chain.nodes.links.includes(ref) || chain.nodes.facts.includes(ref) || chain.nodes.findings.includes(ref));
}

const stepLine = (step: AttackChainStep): string => {
  const parts = [`${step.order}. ${step.claimId ?? step.claimRef ?? step.step}`,
    `[${step.state}${step.executed ? ' · executed' : ''}]`];
  if (step.needs.length) parts.push(`needs ${step.needs.map(describeCapability).join('+')}`);
  if (step.gained.length) parts.push(`gained ${step.gained.map(describeCapability).join('+')}`);
  if (step.effect) parts.push(`effect ${step.effect}`);
  const nodes = [step.nodeRefs.link, step.nodeRefs.fact, step.nodeRefs.finding].filter((value): value is string => value !== undefined);
  if (nodes.length) parts.push(`nodes ${nodes.join(' ')}`);
  if (step.orderEdge) parts.push(step.orderEdge === 'recorded' ? 'order recorded' : 'order step-only');
  return clip(parts.join(' — '), ATTACK_CHAIN_LINE_CHARS);
};

const byteSize = (line: string): number => Buffer.byteLength(line) + 1;

export interface AttackChainRender { lines: string[]; bytes: number; truncated: boolean }

/**
 * Host lines for one chain. Lines are whole rows: a byte cap drops trailing step rows, says how many, and keeps the footer,
 * so a short page is never read as a complete chain.
 */
export function attackChainLines(chain: AttackChain, options: { byteCap?: number } = {}): AttackChainRender {
  const cap = Number.isSafeInteger(options.byteCap) && options.byteCap! > 0 ? options.byteCap! : ATTACK_CHAIN_BYTES;
  const executed = chain.steps.filter(step => step.executed).length;
  const head = clip(`CHAIN ${clip(chain.id, 80)} (${chain.steps.length} step(s); ${chain.sources.join('+')}; ${executed} executed`
    + `${chain.demonstratedThrough !== undefined ? ` through step ${chain.demonstratedThrough}` : ''})`
    + `${chain.objective ? ` — objective: ${chain.objective}` : ''}`, ATTACK_CHAIN_LINE_CHARS);
  const footer = 'Derived from recorded rows; only receipts and the case rating are evidence.';
  const nextLine = chain.next
    ? clip(`NEXT: step ${chain.next.order} ${chain.next.claimId ?? chain.next.step}${chain.next.needs.length ? ` (needs ${chain.next.needs.map(describeCapability).join(', ')})` : ' (ready)'}`, ATTACK_CHAIN_LINE_CHARS)
    : undefined;
  const restored = chain.truncated || chain.omittedSteps > 0;
  const omittedLine = `OMITTED: ${chain.omittedSteps} step(s) not shown; the chain board holds every row.`;

  const lines: string[] = [head];
  let bytes = byteSize(head);
  let dropped = 0;
  // Reserve the footer and (when present) the omission notice so a bounded page still states what it hid.
  const reserved = byteSize(footer) + byteSize(omittedLine) + (nextLine ? byteSize(nextLine) : 0);
  for (const step of chain.steps) {
    const line = stepLine(step), size = byteSize(line);
    if (bytes + size + reserved > cap) { dropped += 1; continue; }
    lines.push(line); bytes += size;
  }
  if (nextLine && bytes + byteSize(nextLine) + byteSize(footer) + (dropped ? byteSize(omittedLine) : 0) <= cap) {
    lines.push(nextLine); bytes += byteSize(nextLine);
  }
  const hidden = dropped + chain.omittedSteps;
  if (hidden > 0) { lines.push(omittedLine); bytes += byteSize(omittedLine); }
  lines.push(footer); bytes += byteSize(footer);
  return { lines, bytes, truncated: hidden > 0 || restored };
}

/** The one-line chain position the planner brief prints: recorded order plus the next recorded step. */
export function attackChainOrderLine(chain: AttackChain): string {
  const order = chain.steps.map(step => step.order).join('\u2192');
  const next = chain.next ? ` (next: step ${chain.next.order} ${clip(chain.next.claimId ?? chain.next.step, 80)})` : '';
  return clip(`Chain order: ${clip(chain.id, 60)} ${order}${next}`, ATTACK_CHAIN_LINE_CHARS);
}

/** The plain rows the report's message-free graph section prints; no `Capability` object reaches the report file. */
export function attackChainReportRows(set: AttackChainSet): ExplorationReportChain[] {
  return set.chains.map(chain => ({
    id: chain.id, sources: [...chain.sources],
    ...(chain.demonstratedThrough !== undefined ? { demonstratedThrough: chain.demonstratedThrough } : {}),
    omittedSteps: chain.omittedSteps,
    steps: chain.steps.map(step => ({
      order: step.order, state: step.state, executed: step.executed,
      ...(step.claimId ?? step.claimRef ? { claimId: step.claimId ?? step.claimRef } : {}),
      ...(step.effect ? { effect: step.effect } : {}),
      needs: step.needs.map(describeCapability), gained: step.gained.map(describeCapability),
      nodes: [step.nodeRefs.link, step.nodeRefs.fact, step.nodeRefs.finding].filter((value): value is string => value !== undefined),
      ...(step.orderEdge ? { orderEdge: step.orderEdge } : {}),
    })),
  }));
}

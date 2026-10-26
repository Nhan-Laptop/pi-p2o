import { CONTROL } from './validate.js';

/**
 * planning_update.md A6.1 (D9/D11): the campaign frame a run records once — objective, operator constraints,
 * authorized-target revision, heartbeat and start time. Pure data and prompt composition only: no I/O, no clock,
 * no authority. The ledger owns persistence; this module parses, builds and renders the record.
 */

/** ARTEX parity (`server/engine.go:779-787`). A heartbeat is a timer, never a work allowance. */
export const DEFAULT_HEARTBEAT_SECONDS = 600;
/** An enabled heartbeat below this is churn, not supervision. `0` disables the timer. */
export const MIN_HEARTBEAT_SECONDS = 120;

export interface CampaignConstraint { rule: 'allow' | 'deny'; text: string }

export interface CampaignRecord {
  v: 1;
  objective: string;
  constraints: CampaignConstraint[];
  /** Opaque revision of the authorized target recorded at start; empty when the caller had none. */
  targetRevision: string;
  /** `0` disables; otherwise at least {@link MIN_HEARTBEAT_SECONDS} once the record is built. */
  heartbeatSeconds: number;
  startedAt: string;
  createdBy: 'operator' | 'default';
}

const OBJECTIVE_MAX = 600;
const CONSTRAINT_MAX = 300;
const CONSTRAINT_LIMIT = 12;
const REVISION_MAX = 200;
/** The prompt block stays strictly below this so it cannot crowd out the rest of the planner prompt. */
const PROMPT_MAX = 600;
/** Deterministic stand-in when a caller supplies no usable `startedAt`; this module never reads a clock. */
const EPOCH = '1970-01-01T00:00:00.000Z';
const ALL_CONTROL = new RegExp(CONTROL.source, 'g');

/** One line, no C0/C1 controls or bidi overrides: every recorded field is prompt text. */
function singleLine(value: string): string {
  return value.replace(ALL_CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

function clip(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return maximum <= 3 ? value.slice(0, maximum) : `${value.slice(0, maximum - 3).trimEnd()}...`;
}

/** Escape anything outside printable ASCII, so host-rendered lines stay single-line ASCII whatever the operator typed. */
function ascii(value: string): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0x20 && codePoint <= 0x7e) result += character;
    else if (codePoint > 0xffff) result += `\\u{${codePoint.toString(16)}}`;
    else result += `\\u${codePoint.toString(16).padStart(4, '0')}`;
  }
  return result;
}

/** A bounded ASCII JSON string literal: a target label cannot break out of the objective or dominate it. */
function quoted(value: string): string {
  const literal = ascii(JSON.stringify(value));
  return literal.length <= 400 ? literal : `${literal.slice(0, 395).replace(/\\+$/u, '')}"`;
}

/** Bounded, defaulted and deterministic; never throws. `0` disables, 1..119 clamps up, bad values fall back. */
function heartbeat(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_HEARTBEAT_SECONDS;
  if (value === 0) return 0;
  if (value < MIN_HEARTBEAT_SECONDS) return MIN_HEARTBEAT_SECONDS;
  const seconds = Math.floor(value);
  return Number.isSafeInteger(seconds) ? seconds : DEFAULT_HEARTBEAT_SECONDS;
}

function revision(value: unknown): string {
  return typeof value === 'string' ? clip(singleLine(value), REVISION_MAX) : '';
}

/** Accepted only when it is a single-line, plausible timestamp; the caller supplies it, this module never reads a clock. */
function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length >= 10 && text.length <= 64 && singleLine(text) === text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

/** Operator `--avoid` entries are denials: trimmed lines, deduped, at most {@link CONSTRAINT_LIMIT}, each bounded. */
function avoidConstraints(value: unknown): CampaignConstraint[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(), constraints: CampaignConstraint[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    for (const line of entry.split(/\r\n|[\r\n\u2028\u2029]/u)) {
      const text = clip(singleLine(line), CONSTRAINT_MAX);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      constraints.push({ rule: 'deny', text });
      if (constraints.length === CONSTRAINT_LIMIT) return constraints;
    }
  }
  return constraints;
}

/** Canonical stored text: a string of the right size that is already exactly one trimmed line. */
function canonical(value: unknown, maximum: number, minimum = 1): string | undefined {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || singleLine(value) !== value) return undefined;
  return value;
}

/**
 * Parse a stored campaign record; returns undefined for anything malformed (never throws).
 * Unknown extra properties are ignored so a lifecycle row can carry its own envelope fields.
 */
export function parseCampaign(value: unknown): CampaignRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.v !== 1) return undefined;
  const objective = canonical(row.objective, OBJECTIVE_MAX);
  if (objective === undefined || !Array.isArray(row.constraints) || row.constraints.length > CONSTRAINT_LIMIT) return undefined;
  const constraints: CampaignConstraint[] = [];
  for (const entry of row.constraints) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const constraint = entry as Record<string, unknown>;
    if (constraint.rule !== 'allow' && constraint.rule !== 'deny') return undefined;
    const text = canonical(constraint.text, CONSTRAINT_MAX);
    if (text === undefined) return undefined;
    constraints.push({ rule: constraint.rule, text });
  }
  const targetRevision = canonical(row.targetRevision, REVISION_MAX, 0);
  if (targetRevision === undefined) return undefined;
  const heartbeatSeconds = row.heartbeatSeconds;
  if (typeof heartbeatSeconds !== 'number' || !Number.isSafeInteger(heartbeatSeconds) || (heartbeatSeconds !== 0 && heartbeatSeconds < MIN_HEARTBEAT_SECONDS)) return undefined;
  const startedAt = timestamp(row.startedAt);
  if (startedAt === undefined) return undefined;
  if (row.createdBy !== 'operator' && row.createdBy !== 'default') return undefined;
  return { v: 1, objective, constraints, targetRevision, heartbeatSeconds, startedAt, createdBy: row.createdBy };
}

/**
 * The record the run will persist. A campaign is created once and never rewritten: an existing record wins even when
 * this call carries a different goal, target or heartbeat. `0` disables heartbeats; a non-zero value below
 * {@link MIN_HEARTBEAT_SECONDS} clamps up to the floor rather than silently doing nothing.
 */
export function campaignFrom(args: { goal?: string; avoid?: readonly string[]; heartbeatSeconds?: number; targetRevision?: string; target: string; at: string }, existing?: CampaignRecord): CampaignRecord {
  if (existing) return existing;
  const input = args ?? ({} as typeof args);
  const goal = typeof input.goal === 'string' ? clip(singleLine(input.goal), OBJECTIVE_MAX) : '';
  return {
    v: 1,
    objective: goal || defaultObjective(input.target),
    constraints: avoidConstraints(input.avoid),
    targetRevision: revision(input.targetRevision),
    heartbeatSeconds: heartbeat(input.heartbeatSeconds),
    startedAt: timestamp(input.at) ?? EPOCH,
    createdBy: goal ? 'operator' : 'default',
  };
}

/** Objective used when the operator gave no --goal: derived from the authorized target, bounded and ASCII-safe. */
export function defaultObjective(target: string): string {
  const value = typeof target === 'string' ? target.trim() : '';
  const subject = value ? `the authorized target ${quoted(value)}` : 'the authorized target';
  return clip(`Assess ${subject} within the operator's recorded constraints.`, OBJECTIVE_MAX);
}

/** One deterministic line for the start confirmation: objective, constraint counts, heartbeat and who authored it. */
export function campaignStartLine(campaign: CampaignRecord): string {
  const deny = campaign.constraints.filter(constraint => constraint.rule === 'deny').length;
  const allow = campaign.constraints.length - deny;
  const heartbeatLine = campaign.heartbeatSeconds === 0
    ? 'heartbeat 0s (heartbeats are disabled; no paid rounds are consumed)'
    : `heartbeat ${campaign.heartbeatSeconds}s (heartbeats consume paid rounds; each wake starts a planner round, and --heartbeat-seconds 0 disables them)`;
  return `Campaign "${ascii(campaign.objective)}" | constraints: ${deny} deny, ${allow} allow | ${heartbeatLine} | started ${ascii(campaign.startedAt)} | created by ${campaign.createdBy}`;
}

const WIDEN = "The planner may widen the operator objective within the operator's authorization but must not silently narrow or replace it; report a blocking constraint instead of bypassing it.";

function promptLine(objective: string, constraints: readonly CampaignConstraint[], omitted: number): string {
  const parts = constraints.map(constraint => `${constraint.rule} "${constraint.text}"`);
  if (omitted > 0) parts.push(`${omitted} more recorded constraint${omitted === 1 ? '' : 's'} omitted here; read the campaign record`);
  return `CAMPAIGN objective "${objective}" | constraints (deny = absolute; allow = permission only): ${parts.length ? parts.join('; ') : 'none recorded'} | ${WIDEN}`;
}

/**
 * The planner-prompt block: objective, recorded constraints in order (`deny` absolute, `allow` a permission), and the
 * widen-not-narrow rule. One line under {@link PROMPT_MAX} characters with ASCII framing; operator text stays verbatim.
 * When a pathological record cannot fit, the objective is shortened first and leading constraints are kept, with the
 * remainder counted rather than dropped silently.
 */
export function campaignPromptBlock(campaign: CampaignRecord): string {
  // Producers already record canonical one-line text; normalising again keeps a hand-built record from breaking the line.
  const objective = singleLine(campaign.objective);
  const constraints = campaign.constraints.map(constraint => ({ rule: constraint.rule, text: singleLine(constraint.text) }));
  const full = promptLine(objective, constraints, 0);
  if (full.length < PROMPT_MAX) return full;
  const shortened = clip(objective, 160);
  for (let included = constraints.length; included >= 0; included -= 1) {
    const line = promptLine(shortened, constraints.slice(0, included), constraints.length - included);
    if (line.length < PROMPT_MAX) return line;
  }
  return clip(promptLine('', [], constraints.length), PROMPT_MAX - 1);
}

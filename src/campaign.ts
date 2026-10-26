import { CASE_EFFECTS, type CaseEffect } from './cvss.js';
import { CONTROL } from './validate.js';

/**
 * planning_update.md A6.1 (D9/D11): the campaign frame a run records once — objective, operator constraints,
 * authorized-target revision, heartbeat and start time. P7.1 (D15) adds the engagement mode and the authorized
 * effect classes. Pure data and prompt composition only: no I/O, no clock, no authority. The ledger owns
 * persistence; this module parses, builds and renders the record.
 */

/** ARTEX parity (`server/engine.go:779-787`). A heartbeat is a timer, never a work allowance. */
export const DEFAULT_HEARTBEAT_SECONDS = 600;
/** An enabled heartbeat below this is churn, not supervision. `0` disables the timer. */
export const MIN_HEARTBEAT_SECONDS = 120;

/**
 * D15 (owner decision 2026-10-26): `exploit` is the default. `assess` is the opt-in read-only shape: the host then
 * refuses any exploitation or chaining intent, so a run cannot claim effects it was not authorized to produce.
 */
export const ENGAGEMENT_MODES = ['assess', 'exploit'] as const;
export type EngagementMode = typeof ENGAGEMENT_MODES[number];
export const DEFAULT_MODE: EngagementMode = 'exploit';
/**
 * D15/Q9: the default authorization is every effect class except `availability-loss`, which stays opt-in because it
 * destroys the thing being assessed. The flag is repeatable, so an operator narrows this set per run.
 */
export const DEFAULT_EFFECT_CLASSES: readonly CaseEffect[] = CASE_EFFECTS.filter(effect => effect !== 'availability-loss');

export interface CampaignConstraint { rule: 'allow' | 'deny'; text: string }

export interface CampaignRecord {
  v: 2;
  objective: string;
  constraints: CampaignConstraint[];
  /** Opaque revision of the authorized target recorded at start; empty when the caller had none. */
  targetRevision: string;
  /** `0` disables; otherwise at least {@link MIN_HEARTBEAT_SECONDS} once the record is built. */
  heartbeatSeconds: number;
  startedAt: string;
  createdBy: 'operator' | 'default';
  /** D15: `assess` refuses exploitation/chaining intents at admission; `exploit` (default) admits them under a goal. */
  mode: EngagementMode;
  /** D15/Q9: the effect classes this engagement authorizes; always empty in `assess` mode. */
  effectClasses: CaseEffect[];
  /**
   * A7.8/D22: the operator's out-of-band callback URL — a destination the target reaches, never an in-sandbox listener.
   * Absent when the operator configured no ingress path.
   */
  callback?: string;
  /** A7.8/D22: the operator's throwaway docker network the sandbox joins, so the target can route back to a listener. */
  labNetwork?: string;
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

/**
 * A7.9/D23: `--avoid` lines are denials and `--allow` lines are permissions; both are trimmed, deduped and bounded. The two
 * lists stay separate on purpose: a later reader must see which word is absolute and which only permits.
 */
function constraintList(value: unknown, rule: CampaignConstraint['rule']): CampaignConstraint[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(), constraints: CampaignConstraint[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    for (const line of entry.split(/\r\n|[\r\n\u2028\u2029]/u)) {
      const text = clip(singleLine(line), CONSTRAINT_MAX);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      constraints.push({ rule, text });
      if (constraints.length === CONSTRAINT_LIMIT) return constraints;
    }
  }
  return constraints;
}
const avoidConstraints = (value: unknown): CampaignConstraint[] => constraintList(value, 'deny');
const allowConstraints = (value: unknown): CampaignConstraint[] => constraintList(value, 'allow');

/** Canonical stored text: a string of the right size that is already exactly one trimmed line. */
function canonical(value: unknown, maximum: number, minimum = 1): string | undefined {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || singleLine(value) !== value) return undefined;
  return value;
}

/**
 * Canonical effect-class set: known classes only, deduped and stored in {@link CASE_EFFECTS} order so two equal
 * authorizations render identically. Returns undefined for anything malformed (never throws).
 */
export function parseEffectClasses(value: unknown): CaseEffect[] | undefined {
  if (!Array.isArray(value) || value.length > CASE_EFFECTS.length) return undefined;
  const selected = new Set<CaseEffect>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !(CASE_EFFECTS as readonly string[]).includes(entry)) return undefined;
    selected.add(entry as CaseEffect);
  }
  return CASE_EFFECTS.filter(effect => selected.has(effect));
}

/** D15: the mode an operator may name; undefined for anything else. */
export function parseMode(value: unknown): EngagementMode | undefined {
  return value === 'assess' || value === 'exploit' ? value : undefined;
}

const CALLBACK_MAX = 2048;
const LAB_NETWORK = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
/** Built-in docker networks cannot be a lab segment: `host` breaks the container boundary and `none`/`bridge` route nothing back. */
const RESERVED_NETWORKS: ReadonlySet<string> = new Set(['host', 'none', 'bridge']);

/**
 * A7.8: one absolute http(s) URL the target may reach, with no credentials and no fragment — it is printed in prompts, so it
 * must be a destination, not a secret or a page anchor. Undefined for anything malformed (never throws).
 */
export function parseCallbackUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > CALLBACK_MAX || singleLine(value) !== value) return undefined;
  if (/[\x00-\x1f\x7f\s]/u.test(value) || !/^https?:\/\//i.test(value)) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.hash) return undefined;
  if (!url.hostname) return undefined;
  return value;
}

/** A7.8: an operator-created docker network name. Built-ins are refused here so a lab network cannot silently be host-level. */
export function parseLabNetwork(value: unknown): string | undefined {
  if (typeof value !== 'string' || !LAB_NETWORK.test(value) || RESERVED_NETWORKS.has(value.toLowerCase())) return undefined;
  return value;
}

/** A7.8: the ingress facts a prompt or report states. Both channels are optional and independent. */
export interface IngressFacts { callback?: string; labNetwork?: string }

/** What a recorded campaign authorizes for inbound proof; undefined when neither channel was configured. */
export function ingressFacts(campaign: Pick<CampaignRecord, 'callback' | 'labNetwork'> | undefined): IngressFacts | undefined {
  if (!campaign || (!campaign.callback && !campaign.labNetwork)) return undefined;
  return { ...(campaign.callback ? { callback: campaign.callback } : {}), ...(campaign.labNetwork ? { labNetwork: campaign.labNetwork } : {}) };
}

/**
 * A7.8: the honest ingress block, shared by the planner prompt and every worker brief. It says what the path can prove and
 * what it cannot: the callback is a destination the target reaches, and a listener exists only on the operator's lab network.
 * Both fallbacks are named: without either, a blind effect is proven by a recorded side effect or timing, or it stays a gap.
 */
export function ingressLines(ingress: IngressFacts | undefined): string[] {
  if (!ingress || (!ingress.callback && !ingress.labNetwork)) {
    return ['INGRESS — none configured. The target cannot call back to an operator collaborator, and no sandbox port is published, so an in-sandbox listener is unreachable. A blind effect (a reverse shell or callback-only command execution) is proven by a recorded side effect or timing, or it stays an open gap; p2o_session action=listen refuses without --lab-network.'];
  }
  return [
    ...(ingress.callback ? [`INGRESS — operator callback ${ingress.callback}: this is a DESTINATION the target reaches out to, not a listener. Route a blind effect's proof (a unique token, hostname or fetched URL) there; the operator observes it out-of-band and the report names the endpoint.`] : []),
    ...(ingress.labNetwork ? [`INGRESS — operator lab network "${ingress.labNetwork}": every sandbox joins it and no port is published to the host. The target can route back to a listener started by p2o_session action=listen (port, optional protocol; the tool healthchecks it and records the address to hand the target). The listener lives inside the already-accepted sandbox blast radius.`] : []),
  ];
}

/**
 * Parse a stored campaign record; returns undefined for anything malformed (never throws).
 * Unknown extra properties are ignored so a lifecycle row can carry its own envelope fields.
 * A `v: 1` record was recorded before the engagement mode existed, so it reads as `assess`: that run's operator
 * confirmed a read-only assessment, and reading it as the new default would retroactively authorize an access ladder.
 */
export function parseCampaign(value: unknown): CampaignRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.v !== 1 && row.v !== 2) return undefined;
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
  const base: Omit<CampaignRecord, 'mode' | 'effectClasses'> = { v: 2, objective, constraints, targetRevision, heartbeatSeconds, startedAt, createdBy: row.createdBy };
  if (row.v === 1) return { ...base, mode: 'assess', effectClasses: [] };
  const mode = parseMode(row.mode);
  const effectClasses = parseEffectClasses(row.effectClasses);
  if (mode === undefined || effectClasses === undefined) return undefined;
  // An assess run authorizes no effect: a stored record that claims both would be two answers to the same question.
  if (mode === 'assess' && effectClasses.length) return undefined;
  // A7.8: a stored ingress fact is validated like a flag; a malformed one makes the record unreadable rather than ignored.
  let callback: string | undefined, labNetwork: string | undefined;
  if (row.callback !== undefined) { callback = parseCallbackUrl(row.callback); if (callback === undefined) return undefined; }
  if (row.labNetwork !== undefined) { labNetwork = parseLabNetwork(row.labNetwork); if (labNetwork === undefined) return undefined; }
  return { ...base, mode, effectClasses, ...(callback ? { callback } : {}), ...(labNetwork ? { labNetwork } : {}) };
}

/**
 * The record the run will persist. A campaign is created once and never rewritten: an existing record wins even when
 * this call carries a different goal, target or heartbeat. `0` disables heartbeats; a non-zero value below
 * {@link MIN_HEARTBEAT_SECONDS} clamps up to the floor rather than silently doing nothing.
 */
export function campaignFrom(args: { goal?: string; avoid?: readonly string[]; allow?: readonly string[]; heartbeatSeconds?: number; targetRevision?: string; target: string; at: string; mode?: EngagementMode; effectClasses?: readonly CaseEffect[]; callback?: string; labNetwork?: string }, existing?: CampaignRecord): CampaignRecord {
  if (existing) return existing;
  const input = args ?? ({} as typeof args);
  const goal = typeof input.goal === 'string' ? clip(singleLine(input.goal), OBJECTIVE_MAX) : '';
  const mode = parseMode(input.mode) ?? DEFAULT_MODE;
  // A malformed explicit list falls back to the default authorization rather than silently narrowing to nothing.
  const requested = parseEffectClasses(input.effectClasses ?? [...DEFAULT_EFFECT_CLASSES]) ?? [...DEFAULT_EFFECT_CLASSES];
  const createdBy: CampaignRecord['createdBy'] = goal ? 'operator' : 'default';
  return {
    v: 2,
    objective: goal || defaultObjective(input.target),
    constraints: [...avoidConstraints(input.avoid), ...allowConstraints(input.allow)],
    targetRevision: revision(input.targetRevision),
    heartbeatSeconds: heartbeat(input.heartbeatSeconds),
    startedAt: timestamp(input.at) ?? EPOCH,
    createdBy,
    mode,
    effectClasses: mode === 'assess' ? [] : requested,
    // A7.8: ingress is recorded verbatim only when it parsed; a malformed value is not guessed into the frame.
    ...(parseCallbackUrl(input.callback) ? { callback: parseCallbackUrl(input.callback)! } : {}),
    ...(parseLabNetwork(input.labNetwork) ? { labNetwork: parseLabNetwork(input.labNetwork)! } : {}),
  };
}

/** Objective used when the operator gave no --goal: derived from the authorized target, bounded and ASCII-safe. */
export function defaultObjective(target: string): string {
  const value = typeof target === 'string' ? target.trim() : '';
  const subject = value ? `the authorized target ${quoted(value)}` : 'the authorized target';
  return clip(`Assess ${subject} within the operator's recorded constraints.`, OBJECTIVE_MAX);
}

/** D15: the engagement line printed wherever the run states what the operator authorized. */
export function engagementLine(mode: EngagementMode, effectClasses: readonly CaseEffect[]): string {
  return mode === 'assess'
    ? 'mode assess (read-only: the host refuses exploitation and chaining intents)'
    : `mode exploit (access ladder authorized for effect classes: ${effectClasses.length ? effectClasses.join(', ') : 'none'})`;
}

/** One deterministic line for the start confirmation: objective, constraint counts, heartbeat and who authored it. */
export function campaignStartLine(campaign: CampaignRecord): string {
  const deny = campaign.constraints.filter(constraint => constraint.rule === 'deny').length;
  const allow = campaign.constraints.length - deny;
  const heartbeatLine = campaign.heartbeatSeconds === 0
    ? 'heartbeat 0s (heartbeats are disabled; no paid rounds are consumed)'
    : `heartbeat ${campaign.heartbeatSeconds}s (heartbeats consume paid rounds; each wake starts a planner round, and --heartbeat-seconds 0 disables them)`;
  const ingress = ingressFacts(campaign);
  const ingressLine = ingress ? ` | ingress: ${[ingress.callback ? `callback ${ascii(ingress.callback)}` : '', ingress.labNetwork ? `lab network ${ascii(ingress.labNetwork)}` : ''].filter(Boolean).join(', ')}` : '';
  return `Campaign "${ascii(campaign.objective)}" | ${engagementLine(campaign.mode, campaign.effectClasses)} | constraints: ${deny} deny, ${allow} allow | ${heartbeatLine} | started ${ascii(campaign.startedAt)} | created by ${campaign.createdBy}${ingressLine}`;
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

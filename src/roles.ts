import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { purposeFromRole, type WorkPurpose } from './duties.js';
import { parseCommandPolicy, type OperatorPolicy } from './policy.js';

/**
 * Roles preselect a model and a starting skill set for a delegated worker.
 * They never grant scope: the ticket fixes the target, and only the human can widen it.
 */
// planning_update.md P14.4: `exploit` exists so taking a primitive to impact has an owner. It grants no scope: a role only
// selects a model and a starting skill set, and the ticket still fixes the target.
export const ROLES = ['recon', 'discovery', 'validation', 'reporting', 'exploit', 'general'] as const;
export type Role = typeof ROLES[number];
/** Reasoning levels a worker pane can be launched with (the Pi `--thinking` values). */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface RoleDefaults { model?: string; thinking?: string; skills: string[] }
export interface RoleSettings { model?: string; thinking?: string; skills?: string[] }

export const ROLE_DEFAULTS: Record<Role, RoleDefaults> = {
  recon: { model: 'opencode-go/deepseek-v4-flash', skills: ['attack-surface-mapping'] },
  discovery: { model: 'opencode-go/deepseek-v4-flash', skills: ['source-code-auditing'] },
  validation: { model: 'opencode-go/kimi-k3', skills: [] },
  reporting: { model: 'opencode-go/kimi-k3', skills: [] },
  // The strongest configured model, because this worker has to build something that runs. `skills` stays empty until
  // planning_update.md P14.6 registers `exploit-design`; pointing at a skill the catalog does not contain would break the
  // catalog drift test and, worse, silently hand the worker no guidance at all.
  exploit: { model: 'opencode-go/kimi-k3', skills: [] },
  general: { skills: [] },
};
/**
 * planning_update.md P7: purpose decides the default skill set, because purpose is what the work *is* while role only picks
 * the model/authority axis. Used when the lead omits `skills` and the operator configured none for the role.
 * `tests/minimal/roles.test.ts` checks every id against `skills/catalog.json` and against `MAX_SKILLS`.
 *
 * P15 (W3/W5): a default skill may not teach the opposite of its own duty. `validation` reproduces another worker's claim and
 * must never start a new discovery, so it no longer starts from `exploitability-assessment` (which continues into impact and
 * the chain); `reporting` synthesizes and may not author fixes, so it no longer starts from `remediation`. Both keep their role
 * model and their duty line, and either skill stays reachable by an explicit request. P17.8/A17.6 scopes the validation rule:
 * with the claim's `needs` named, `purposeSkills` hands it that claim's ladder, because replaying the method is reproduction and
 * not discovery; the empty list here is the no-needs default.
 *
 * An empty list is a decision, not a gap: "this purpose ships no method default" (investigation is guided by the task's own
 * method; validation and reporting must not start work). So an explicitly supplied purpose never falls back to the role
 * default, which applies only when the caller supplies no purpose at all (see `resolveRole`).
 */
export const PURPOSE_SKILLS: Record<WorkPurpose, readonly string[]> = {
  mapping: ['attack-surface-mapping'],
  discovery: ['source-code-auditing'],
  investigation: [],
  refinement: ['source-code-auditing'],
  validation: [],
  retest: ['remediation'],
  exploitation: ['exploit-design'],
  chaining: ['exploit-design'],
  reporting: [],
};

export type TargetKindForSkills = 'directory' | 'url' | 'hybrid';
export interface SkillContext { kind?: TargetKindForSkills; needs?: readonly string[] }

/**
 * P15 (W4): a ladder belongs to the primitive the step consumes, so it is derived where that need is known instead of being one
 * generic default. `exploit-design` comes first so the single MAX_SKILLS cap in `resolveRole` never drops the general procedure;
 * that cap is applied once, at the selection point, so `omittedSkills` can report a ladder it cut instead of hiding it here.
 * An unknown kind simply selects no ladder, which is the pre-P15 behaviour rather than a guess.
 *
 * P17.8/A17.6 (D37): a demonstrated `host.shell` is the rung after execution, so `session-to-root` is the method for it and it
 * takes its place ahead of the credential ladder — the cap drops the furthest rung, never the one the frontier just reached.
 * A shell that also holds egress can reach inward, so `internal-pivot` follows the root rung and behind it in the cap: a
 * truncated pivot is reported in `omittedSkills`, never silently replaced, and `ssrf-to-internal` keeps the egress slot.
 * `n-day-to-effect` stays requestable rather than defaulted: no context field carries a CVE or patch-diff lead yet.
 */
export function exploitationSkills(kind: TargetKindForSkills | undefined, needs: readonly string[] = []): string[] {
  const ladder: string[] = [];
  if (needs.includes('net.egress')) ladder.push('ssrf-to-internal');
  if (needs.includes('exec.code')) ladder.push(kind === 'directory' ? 'binary-exploit-ladder' : 'web-injection-to-exec');
  if (needs.includes('host.shell')) ladder.push('session-to-root');
  if (needs.includes('host.shell') && needs.includes('net.egress')) ladder.push('internal-pivot');
  if (needs.includes('cred.session') || needs.includes('cred.secret')) ladder.push('credential-and-pivot');
  return ['exploit-design', ...ladder];
}

/**
 * P15 (W3): the method follows the target as well as the purpose. A URL-only run has no source tree to audit, so its mapping and
 * discovery defaults are the web playbooks; a directory or hybrid run keeps the source methods (a hybrid target still has the
 * snapshot), and the web playbooks stay requestable. Without a kind the base table applies, so a caller with no target context
 * keeps the pre-P15 defaults.
 *
 * Refinement and retest are source-based methods too: `source-code-auditing` needs a tree and `remediation` a changed revision of
 * one, so a URL-only run gets no method default for either. A directory or hybrid target keeps them, and an explicit request may
 * still name any skill regardless of kind, because this rule only chooses defaults.
 */
export function purposeSkills(purpose: WorkPurpose, context: SkillContext = {}): readonly string[] {
  if (context.kind === 'url') {
    if (purpose === 'mapping') return ['web-deployment-hygiene'];
    if (purpose === 'discovery') return ['web-route-input-inventory'];
    if (purpose === 'refinement' || purpose === 'retest') return [];
  }
  if (purpose === 'exploitation' || purpose === 'chaining') return exploitationSkills(context.kind, context.needs);
  // P17.8/A17.6 (D37): reproduction needs the method that produced the effect. A validation task that names the claim's
  // `needs` gets the ladder an exploitation task would have climbed — `exploit-design` starts at Gate R (reproduce), and
  // the family member is what the claim was reached through. With no `needs` the purpose list stays empty (P15/W5): a
  // validation worker is never handed a method it did not ask to replay, and never starts a new discovery.
  if (purpose === 'validation' && context.needs?.length) return exploitationSkills(context.kind, context.needs);
  return PURPOSE_SKILLS[purpose];
}
export const DEFAULT_MAX_WORKERS = 3;
export const DEFAULT_MAX_DEPTH = 2;
// Capacity is operator-controlled, not a lifetime assignment budget. Live frontier, command,
// provider and Herdr resource limits still apply; confirmation names the selected capacity.
export const MAX_WORKERS = Number.MAX_SAFE_INTEGER;
export const MAX_DEPTH = 3;
export const MAX_SKILLS = 3;

export type LoopMode = 'manual' | 'event-driven';
export type RetentionMode = 'durable-local' | 'ephemeral';
export const DEFAULT_STORAGE_QUOTA_MIB = 256;
export const DEFAULT_ARTIFACT_CAPTURE_KIB = 1024;
export const DEFAULT_GRAPH_CAPACITY = 2;
/** Must equal `MAX_GRAPH_CAPACITY` in `state/graph.ts`: parse clamps to the same range the store refuses outside of. */
export const MAX_GRAPH_CAPACITY = 4;
/**
 * Off by default. The 2026-10-10 benchmark (32-run A/B plus a 16-run ablation, `git show 41e8157:planning_update.md` §0.2) showed the guidance steers the model to the
 * K3-K6 tools 2-7x more often but raised cost ~70%, turns ~60% and invalid (timeout/turn-budget) runs from 1/16 to 3/16 with no recall or precision gain.
 */
export const DEFAULT_TOOL_GUIDANCE = false;
export type ReviewIntegrity = 'off' | 'annotate' | 'enforce';
export interface P2OSettings {
  maxWorkers: number;
  maxDepth: number;
  loopMode: LoopMode;
  executorMode: 'shared' | 'isolated' | 'session';
  maxTargetOperations: number;
  retention: RetentionMode;
  storageQuotaMiB: number;
  artifactCaptureKiB: number;
  /** P9/B (Q29): multiplier on the hard graph ceilings (1..4); default 2 doubles every capacity the store enforces. */
  graphCapacity: number;
  /** Write the deterministic report when a durable-local run is cleaned up (finish, stop, shutdown). Ephemeral runs keep it off unless set explicitly. */
  autoReport: boolean | undefined;
  /** Absolute directory that receives report-<runId>/; default is <cwd>/.p2o-reports. */
  reportRoot?: string;
  /** 1 = the original report files only, 2 = adds findings.json/csv and the WSTG checklist CSV. */
  reportFormat: 1 | 2;
  /** annotate = report who authored each review receipt; enforce also refuses a review whose receipts the assignee did not author. */
  reviewIntegrity: ReviewIntegrity;
  /** A7.7/P7.3: operator command-policy rules and seeded denies the operator disabled; absent means the default policy. */
  commandPolicy?: OperatorPolicy;
  /** Optional operator labels printed in the report (author, organization, team, classification, disclaimer). */
  reportMeta?: Partial<Record<'author' | 'organization' | 'team' | 'classification' | 'disclaimer', string>>;
  roles: Partial<Record<Role, RoleSettings>>;
}

const blank = (): P2OSettings => ({ maxWorkers: DEFAULT_MAX_WORKERS, maxDepth: DEFAULT_MAX_DEPTH, loopMode: 'manual', executorMode: 'shared', maxTargetOperations: 3, retention: 'durable-local', storageQuotaMiB: DEFAULT_STORAGE_QUOTA_MIB, artifactCaptureKiB: DEFAULT_ARTIFACT_CAPTURE_KIB, graphCapacity: DEFAULT_GRAPH_CAPACITY, autoReport: undefined, reportFormat: 2, reviewIntegrity: 'annotate', roles: {} });

export function isRole(value: unknown): value is Role { return typeof value === 'string' && (ROLES as readonly string[]).includes(value); }

/** Settings are user-controlled data: parse defensively and ignore anything malformed. */
export function parseSettings(raw: unknown): P2OSettings {
  const settings = blank();
  const p2o = (raw as { p2o?: unknown } | null)?.p2o;
  if (!p2o || typeof p2o !== 'object' || Array.isArray(p2o)) return settings;
  const source = p2o as Record<string, unknown>;
  const clamp = (value: unknown, fallback: number, max: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : fallback;
  settings.maxWorkers = clamp(source.maxWorkers, DEFAULT_MAX_WORKERS, MAX_WORKERS);
  settings.loopMode = source.loopMode === 'event-driven' ? 'event-driven' : 'manual';
  settings.executorMode = source.executorMode === 'isolated' || source.executorMode === 'session' ? source.executorMode : 'shared';
  settings.maxTargetOperations = clamp(source.maxTargetOperations,3,Number.MAX_SAFE_INTEGER);
  settings.retention = source.retention === 'ephemeral' ? 'ephemeral' : 'durable-local';
  settings.storageQuotaMiB = typeof source.storageQuotaMiB === 'number' && Number.isInteger(source.storageQuotaMiB) && source.storageQuotaMiB >= 8 && source.storageQuotaMiB <= 1024 ? source.storageQuotaMiB : DEFAULT_STORAGE_QUOTA_MIB;
  settings.artifactCaptureKiB = clamp(source.artifactCaptureKiB, DEFAULT_ARTIFACT_CAPTURE_KIB, 8192);
  settings.graphCapacity = clamp(source.graphCapacity, DEFAULT_GRAPH_CAPACITY, MAX_GRAPH_CAPACITY);
  settings.autoReport = typeof source.autoReport === 'boolean' ? source.autoReport : undefined;
  if (typeof source.reportRoot === 'string' && source.reportRoot.length <= 1024 && isAbsolute(source.reportRoot) && source.reportRoot === source.reportRoot.normalize('NFC') && !/[\x00-\x1f\x7f]/.test(source.reportRoot)) settings.reportRoot = source.reportRoot;
  settings.reportFormat = source.reportFormat === 1 ? 1 : 2;
  const meta = source.report;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const labels: NonNullable<P2OSettings['reportMeta']> = {};
    for (const name of ['author', 'organization', 'team', 'classification', 'disclaimer'] as const) { const value = (meta as Record<string, unknown>)[name]; if (typeof value === 'string' && value.trim() && value.length <= 400 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) labels[name] = value; }
    if (Object.keys(labels).length) settings.reportMeta = labels;
  }
  settings.reviewIntegrity = source.reviewIntegrity === 'off' || source.reviewIntegrity === 'enforce' ? source.reviewIntegrity : 'annotate';
  // A7.7: the policy is user-controlled data and never model text; malformed rules are dropped by the parser, not guessed at.
  const commandPolicy = parseCommandPolicy(source.commandPolicy);
  if (commandPolicy.rules.length || commandPolicy.disableSeeds.length) settings.commandPolicy = commandPolicy;
  settings.maxDepth = typeof source.maxDepth === 'number' && Number.isInteger(source.maxDepth) && source.maxDepth >= 0 && source.maxDepth <= MAX_DEPTH
    ? source.maxDepth : DEFAULT_MAX_DEPTH;
  const roles = source.roles;
  if (roles && typeof roles === 'object' && !Array.isArray(roles)) {
    for (const [name, value] of Object.entries(roles as Record<string, unknown>)) {
      if (!isRole(name) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const role: RoleSettings = {};
      if (typeof entry.model === 'string' && entry.model.length <= 200 && !/[\x00-\x1f\x7f]/.test(entry.model)) role.model = entry.model;
      if (typeof entry.thinking === 'string' && /^[a-z]{2,8}$/.test(entry.thinking)) role.thinking = entry.thinking;
      if (Array.isArray(entry.skills)) {
        const skills = entry.skills.filter((skill): skill is string => typeof skill === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)).slice(0, MAX_SKILLS);
        if (skills.length) role.skills = skills;
      }
      settings.roles[name] = role;
    }
  }
  return settings;
}

export function loadSettings(path = join(homedir(), '.pi', 'agent', 'settings.json')): P2OSettings {
  try { return parseSettings(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return blank(); }
}

export interface ResolvedRole {
  role: Role; model?: string; thinking?: string; skills: string[];
  /** The explicit request exactly as supplied (non-strings dropped), before the MAX_SKILLS cap, so a caller can record what it asked for. */
  requestedSkills: string[];
  /** Ids the MAX_SKILLS cap removed from whichever list won (request, operator setting, purpose or role default); [] when nothing was cut. */
  omittedSkills: string[];
}

/**
 * P10/WF-02 (Q28): the worker models a planner may request per task. It is the package role defaults plus every model the
 * operator configured for a role, so a task can raise or lower cost/quality only inside a set the operator already chose.
 */
export function allowedWorkerModels(settings: P2OSettings): string[] {
  const models = new Set<string>();
  for (const role of ROLES) { const model = ROLE_DEFAULTS[role].model; if (model) models.add(model); }
  for (const role of ROLES) { const model = settings.roles[role]?.model; if (model) models.add(model); }
  return [...models].sort();
}

/**
 * P10/WF-02/03 (Q28): host validation of a per-task runtime request. The host, not the model, decides what is configured:
 * an unconfigured model or an unknown thinking level is refused with the legal set instead of silently inheriting.
 */
export function validateTaskRuntime(runtime: { model?: string; thinking?: string } | undefined, settings: P2OSettings): { model?: string; thinking?: string } | undefined {
  if (!runtime) return undefined;
  const model = typeof runtime.model === 'string' ? runtime.model.trim() : undefined;
  const thinking = typeof runtime.thinking === 'string' ? runtime.thinking.trim() : undefined;
  if (model !== undefined) {
    const allowed = allowedWorkerModels(settings);
    if (!allowed.includes(model)) throw Error(`MODEL_UNAVAILABLE: ${model} is not configured for a worker. legalNext: name one of ${allowed.join(', ')} as runtime.model, or configure p2o.roles.<role>.model`);
  }
  if (thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(thinking)) throw Error(`THINKING_INVALID: ${thinking} is not a thinking level. legalNext: name one of ${THINKING_LEVELS.join(', ')} as runtime.thinking`);
  return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

/**
 * Precedence mirrors pi-herdr: per-spawn override > settings role > package default > parent session model.
 * `skills` is validated by the caller against the installed library before any path is used.
 *
 * P15 (W3/W5): an explicitly supplied purpose speaks even when its list is empty, because [] means "no method default by
 * design"; only a caller that supplies no purpose falls back to the role default. Without that distinction role=discovery +
 * purpose=validation would start from `source-code-auditing`, which is the P15 regression this rule exists to prevent.
 * `requestedSkills`/`omittedSkills` make the MAX_SKILLS cap observable, so a caller records what it lost instead of guessing.
 */
export function resolveRole(input: { role?: string; model?: string; thinking?: string; skills?: string[]; purpose?: WorkPurpose; context?: SkillContext; settings: P2OSettings; parentModel?: string; parentThinking?: string }): ResolvedRole {
  const role: Role = isRole(input.role) ? input.role : 'general';
  const configured = input.settings.roles[role] ?? {};
  const fallback = ROLE_DEFAULTS[role];
  const requested = (input.skills ?? []).filter(skill => typeof skill === 'string');
  const byPurpose = purposeSkills(input.purpose ?? purposeFromRole(role), input.context);
  const byDefault = input.purpose !== undefined || byPurpose.length ? byPurpose : fallback.skills;
  const source = requested.length ? requested : configured.skills ?? byDefault;
  return {
    role,
    model: input.model ?? configured.model ?? fallback.model ?? input.parentModel,
    thinking: input.thinking ?? configured.thinking ?? fallback.thinking ?? input.parentThinking,
    skills: source.slice(0, MAX_SKILLS),
    requestedSkills: requested,
    omittedSkills: source.slice(MAX_SKILLS),
  };
}

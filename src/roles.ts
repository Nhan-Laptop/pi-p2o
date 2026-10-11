import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Roles preselect a model and a starting skill set for a delegated worker.
 * They never grant scope: the ticket fixes the target, and only the human can widen it.
 */
export const ROLES = ['recon', 'discovery', 'validation', 'reporting', 'general'] as const;
export type Role = typeof ROLES[number];

export interface RoleDefaults { model?: string; thinking?: string; skills: string[] }
export interface RoleSettings { model?: string; thinking?: string; skills?: string[] }

export const ROLE_DEFAULTS: Record<Role, RoleDefaults> = {
  recon: { model: 'opencode-go/deepseek-v4-flash', skills: ['attack-surface-mapping'] },
  discovery: { model: 'opencode-go/deepseek-v4-flash', skills: ['source-code-auditing'] },
  validation: { model: 'opencode-go/kimi-k3', skills: ['exploitability-assessment'] },
  reporting: { model: 'opencode-go/kimi-k3', skills: ['remediation'] },
  general: { skills: [] },
};
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
/**
 * Off by default. The 2026-10-10 benchmark (32-run A/B plus a 16-run ablation, `git show 41e8157:planning_update.md` §0.2) showed the guidance steers the model to the
 * K3-K6 tools 2-7x more often but raised cost ~70%, turns ~60% and invalid (timeout/turn-budget) runs from 1/16 to 3/16 with no recall or precision gain.
 */
export const DEFAULT_TOOL_GUIDANCE = false;
export interface P2OSettings {
  maxWorkers: number;
  maxDepth: number;
  loopMode: LoopMode;
  maxPlannerRounds: number;
  executorMode: 'shared' | 'isolated';
  maxTargetOperations: number;
  retention: RetentionMode;
  storageQuotaMiB: number;
  artifactCaptureKiB: number;
  /** Per-tool workflow guidance (src/tool-guidelines.ts). Read when the extension loads; /reload applies a change. */
  toolGuidance: boolean;
  roles: Partial<Record<Role, RoleSettings>>;
}

const blank = (): P2OSettings => ({ maxWorkers: DEFAULT_MAX_WORKERS, maxDepth: DEFAULT_MAX_DEPTH, loopMode: 'manual', maxPlannerRounds: 100, executorMode: 'shared', maxTargetOperations: 3, retention: 'durable-local', storageQuotaMiB: DEFAULT_STORAGE_QUOTA_MIB, artifactCaptureKiB: DEFAULT_ARTIFACT_CAPTURE_KIB, toolGuidance: DEFAULT_TOOL_GUIDANCE, roles: {} });

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
  settings.maxPlannerRounds = clamp(source.maxPlannerRounds, 100, Number.MAX_SAFE_INTEGER);
  settings.executorMode = source.executorMode === 'isolated' ? 'isolated' : 'shared';
  settings.maxTargetOperations = clamp(source.maxTargetOperations,3,Number.MAX_SAFE_INTEGER);
  settings.retention = source.retention === 'ephemeral' ? 'ephemeral' : 'durable-local';
  settings.storageQuotaMiB = typeof source.storageQuotaMiB === 'number' && Number.isInteger(source.storageQuotaMiB) && source.storageQuotaMiB >= 8 && source.storageQuotaMiB <= 1024 ? source.storageQuotaMiB : DEFAULT_STORAGE_QUOTA_MIB;
  settings.artifactCaptureKiB = clamp(source.artifactCaptureKiB, DEFAULT_ARTIFACT_CAPTURE_KIB, 8192);
  settings.toolGuidance = typeof source.toolGuidance === 'boolean' ? source.toolGuidance : DEFAULT_TOOL_GUIDANCE;
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

export interface ResolvedRole { role: Role; model?: string; thinking?: string; skills: string[] }

/**
 * Precedence mirrors pi-herdr: per-spawn override > settings role > package default > parent session model.
 * `skills` is validated by the caller against the installed library before any path is used.
 */
export function resolveRole(input: { role?: string; model?: string; thinking?: string; skills?: string[]; settings: P2OSettings; parentModel?: string; parentThinking?: string }): ResolvedRole {
  const role: Role = isRole(input.role) ? input.role : 'general';
  const configured = input.settings.roles[role] ?? {};
  const fallback = ROLE_DEFAULTS[role];
  const requested = (input.skills ?? []).filter(skill => typeof skill === 'string');
  const skills = (requested.length ? requested : configured.skills ?? fallback.skills).slice(0, MAX_SKILLS);
  return {
    role,
    model: input.model ?? configured.model ?? fallback.model ?? input.parentModel,
    thinking: input.thinking ?? configured.thinking ?? fallback.thinking ?? input.parentThinking,
    skills,
  };
}

/**
 * A7.7 (planning_update.md P7.3): the command policy layer.
 *
 * The run's only constraint used to be `--avoid` text inside a prompt, which is model-level guidance and not an enforcement point. This
 * module is the enforcement point's decision function: pure, host-side, and evaluated before any bytes reach a container. Rules come
 * from operator settings only (never from a model tool or from target text), are ordered, and the seeded deny list covers irreversible
 * host-level mistakes rather than trying to anticipate everything a root shell can encode.
 *
 * Precedence (A7.7): operator `deny` → seeded `deny` → operator `ask` → operator `allow` → default `allow` for a target operation.
 * Seeds are disable-able by the operator (ARTEX parity, artex study `db/db.go:350-430`); a disabled seed is named in the report.
 */

export const POLICY_ACTIONS = ['allow', 'deny', 'ask'] as const;
export type PolicyAction = typeof POLICY_ACTIONS[number];
/** The dispatch kinds the evaluator covers: target commands, network commands, HTTP requests and (P7.4) PTY writes. */
export const POLICY_KINDS = ['shell', 'net', 'http', 'send'] as const;
export type PolicyKind = typeof POLICY_KINDS[number];
export interface PolicyRequest { kind: PolicyKind; text: string }
export interface PolicyRule {
  id: string; action: PolicyAction; match: string; reason: string;
  /** `regex` is reserved for the fixed seed list; an operator rule is a case-insensitive literal substring and is never compiled. */
  mode?: 'regex';
  /** A rule that only makes sense for some dispatch kinds (a Docker CLI pattern must not deny a URL that contains "docker"). */
  kinds?: readonly PolicyKind[];
}
export interface PolicyDecision { action: PolicyAction; ruleId: string; reason: string }
/** The decision plus the recorded pending id when the action is `ask`. */
export interface PolicyOutcome extends PolicyDecision { askId?: string }
export const DEFAULT_RULE_ID = 'default.target-operation';

interface Seed { id: string; pattern: RegExp; reason: string; kinds?: readonly PolicyKind[] }
/**
 * Fixed and deliberately narrow: irreversible host-level mistakes and self-destruction inside the sandbox. Not an egress or scope
 * firewall (Part XI/E keeps the operator's authorization as the boundary), and not a promise that every catastrophic command is caught.
 */
const SEEDS: readonly Seed[] = [
  { id: 'seed.rm-root', pattern: /\brm\s+(?:-[a-zA-Z-]+\s+)*\/(?:\*|\s|$)/, reason: 'recursive removal of the filesystem root', kinds: ['shell', 'net'] },
  { id: 'seed.mkfs', pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/, reason: 'formatting a filesystem device', kinds: ['shell', 'net'] },
  { id: 'seed.dd-device', pattern: /\bdd\b[^\n]*\bof=\/dev\//, reason: 'raw write to a device node', kinds: ['shell', 'net'] },
  { id: 'seed.power', pattern: /(?:^|[;&|]\s*)(?:shutdown|reboot|poweroff|halt)(?:\s|$)/, reason: 'host power-state change', kinds: ['shell', 'net'] },
  { id: 'seed.fork-bomb', pattern: /(?::\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;?\s*:)|(?:\b(\w+)\s*\(\s*\)\s*\{[^}]*\b\1\s*\|\s*\1[^}]*\}[^;{}]*;?\s*\1\b)/, reason: 'fork bomb', kinds: ['shell', 'net'] },
  { id: 'seed.host-path-write', pattern: /(?:>>?|\btee\b|\brm\b|\bmv\b|\bchmod\b|\bchown\b|\bdd\b)[^\n;&|]*\/target(?:\/|\s|$)/, reason: 'write to the host-shared source copy', kinds: ['shell', 'net'] },
  { id: 'seed.docker-cli', pattern: /(?:^|[;&|(]\s*)(?:sudo\s+)?docker(?:\s|$)/, reason: 'Docker CLI use inside the sandbox', kinds: ['shell', 'net'] },
  { id: 'seed.self-destruct', pattern: /(?:^|[;&|]\s*)p?kill(?:all)?\s+(?:-[a-zA-Z0-9]+\s+)*(?:1|-1)(?:\s|$)|(?:^|[;&|]\s*)killall5\b/, reason: 'killing the sandbox init process', kinds: ['shell', 'net'] },
];

/** The fixed deny list, in the order the evaluator applies it. */
export function seededRules(): PolicyRule[] {
  return SEEDS.map(seed => ({ id: seed.id, action: 'deny' as const, match: seed.pattern.source, reason: seed.reason, mode: 'regex' as const, ...(seed.kinds ? { kinds: seed.kinds } : {}) }));
}
/** The seed ids an operator may disable by name. */
export const SEED_IDS: readonly string[] = SEEDS.map(seed => seed.id);

/** Operator settings, normalized. Stored as plain data so it can be persisted and printed; the matcher is built by `commandPolicy`. */
export interface OperatorPolicy { rules: PolicyRule[]; disableSeeds: string[] }
export const EMPTY_POLICY: OperatorPolicy = { rules: [], disableSeeds: [] };
const MAX_OPERATOR_RULES = 20, MAX_RULE_TEXT = 200, MAX_REASON = 200;

const text = (value: unknown, limit: number): string | undefined => typeof value === 'string' && value.trim().length > 0
  && value.trim().length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value.trim() : undefined;

/**
 * Parse the operator's `p2o.commandPolicy` defensively, the same way every other user-controlled setting is parsed: a malformed
 * rule is dropped, never guessed at. `match` is a case-insensitive literal substring — not a regular expression — so operator
 * settings cannot introduce catastrophic backtracking into the hot path of every target operation.
 */
export function parseCommandPolicy(raw: unknown): OperatorPolicy {
  // Accept the p2o settings object, its `p2o` section, or the `commandPolicy` object itself: one shape, parsed once.
  const root = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const nested = root && typeof root.p2o === 'object' && !Array.isArray(root.p2o) ? root.p2o as Record<string, unknown> : undefined;
  const row = (root?.commandPolicy ?? nested?.commandPolicy ?? root) as Record<string, unknown> | undefined;
  if (!row || typeof row !== 'object' || Array.isArray(row)) return EMPTY_POLICY;
  const disabled = Array.isArray(row.disableSeeds) ? [...new Set(row.disableSeeds.filter((id): id is string => typeof id === 'string' && (SEED_IDS as readonly string[]).includes(id)))].sort() : [];
  const rules: PolicyRule[] = [];
  const listed = Array.isArray(row.rules) ? row.rules.slice(0, MAX_OPERATOR_RULES) : [];
  for (const entry of listed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rule = entry as Record<string, unknown>;
    const action = rule.action, match = text(rule.match, MAX_RULE_TEXT), reason = text(rule.reason, MAX_REASON);
    if (!(POLICY_ACTIONS as readonly string[]).includes(action as string) || !match || !reason) continue;
    const id = text(rule.id, 64) && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(String(rule.id).trim()) ? String(rule.id).trim() : `operator.${action as string}.${rules.length}`;
    if (rules.some(existing => existing.id === id)) continue;
    rules.push({ id, action: action as PolicyAction, match, reason });
  }
  return { rules, disableSeeds: disabled };
}

export interface CommandPolicy {
  operatorRules: number;
  enabledSeeds: string[];
  disabledSeeds: string[];
  rules: readonly PolicyRule[];
  evaluate(request: PolicyRequest): PolicyDecision;
}
const matches = (rule: PolicyRule, request: PolicyRequest): boolean => {
  if (rule.kinds && !rule.kinds.includes(request.kind)) return false;
  try { return rule.mode === 'regex' ? new RegExp(rule.match, 'i').test(request.text) : request.text.toLowerCase().includes(rule.match.toLowerCase()); }
  catch { return false; } // A seed pattern is fixed and tested; an unparseable one has no authority.
};
/** The ordered rule list: operator deny → seeded deny → operator ask → operator allow. */
function orderedRules(operator: OperatorPolicy): PolicyRule[] {
  const deny = operator.rules.filter(rule => rule.action === 'deny'), ask = operator.rules.filter(rule => rule.action === 'ask'), allow = operator.rules.filter(rule => rule.action === 'allow');
  const seeds = seededRules().filter(rule => !operator.disableSeeds.includes(rule.id));
  return [...deny, ...seeds, ...ask, ...allow];
}
/** Pure decision over an already ordered rule list. First matching rule wins; no match means the default target-operation allow. */
export function decide(rules: readonly PolicyRule[], request: PolicyRequest): PolicyDecision {
  for (const rule of rules) if (matches(rule, request)) return { action: rule.action, ruleId: rule.id, reason: rule.reason };
  return { action: 'allow', ruleId: DEFAULT_RULE_ID, reason: 'no rule matched; a target operation is allowed inside the confirmed scope' };
}
/** Bind an operator policy into the object the host evaluates: ordered rules, enabled seeds and the report's named disabled seeds. */
export function commandPolicy(operator: OperatorPolicy = EMPTY_POLICY): CommandPolicy {
  const rules = orderedRules(operator);
  return { operatorRules: operator.rules.length, enabledSeeds: rules.filter(rule => SEED_IDS.includes(rule.id)).map(rule => rule.id), disabledSeeds: operator.disableSeeds,
    rules, evaluate: request => decide(rules, request) };
}

/** One audited decision as the ledger stores it, and the digest row that counts allows by rule. */
export interface PolicyDecisionRecord { action: PolicyAction; ruleId: string; count: number }
export interface PolicyAudit {
  operatorRules: number; enabledSeeds: string[]; disabledSeeds: string[];
  /** deny/ask counts from their decision records plus allow counts from the digest records; sorted, one row per action and rule. */
  decisions: PolicyDecisionRecord[];
}
interface AuditRecord { data?: Record<string, unknown> }
/**
 * Read the policy facts out of committed records for the report. The startup record is the only source of the rule shape (a model
 * cannot write it); decisions and allow digests are counted, never re-evaluated, so the report states what happened, not what would.
 */
export function policyAudit(records: readonly AuditRecord[]): PolicyAudit | undefined {
  const startup = records.map(record => record.data?.commandPolicy as Record<string, unknown> | undefined).filter((value): value is Record<string, unknown> => value !== undefined).at(-1);
  if (!startup) return undefined;
  const counts = new Map<string, PolicyDecisionRecord>();
  const add = (action: PolicyAction, ruleId: string, count: number) => {
    const key = `${action}\u0000${ruleId}`, prior = counts.get(key);
    counts.set(key, { action, ruleId, count: (prior?.count ?? 0) + count });
  };
  for (const record of records) {
    const decision = record.data?.policyDecision as Record<string, unknown> | undefined;
    if (decision && (POLICY_ACTIONS as readonly string[]).includes(String(decision.action)) && typeof decision.ruleId === 'string') add(decision.action as PolicyAction, decision.ruleId, 1);
    const ask = record.data?.policyAsk as Record<string, unknown> | undefined;
    if (ask && typeof ask.ruleId === 'string') add('ask', ask.ruleId, 1);
    const digest = record.data?.policyDigest as Record<string, unknown> | undefined;
    const rows = digest?.counts;
    if (rows && typeof rows === 'object' && !Array.isArray(rows)) for (const [ruleId, count] of Object.entries(rows as Record<string, unknown>)) if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) add('allow', ruleId, count);
  }
  const enabled = Array.isArray(startup.enabledSeeds) ? startup.enabledSeeds.filter((id): id is string => typeof id === 'string') : [];
  const disabled = Array.isArray(startup.disabledSeeds) ? startup.disabledSeeds.filter((id): id is string => typeof id === 'string') : [];
  const order = { deny: 0, ask: 1, allow: 2 } as const;
  return { operatorRules: typeof startup.operatorRules === 'number' ? startup.operatorRules : 0, enabledSeeds: enabled, disabledSeeds: disabled,
    decisions: [...counts.values()].sort((left, right) => order[left.action] - order[right.action] || left.ruleId.localeCompare(right.ruleId)) };
}

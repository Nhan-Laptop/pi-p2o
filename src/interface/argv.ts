/**
 * Shell-free argv parsing for the single `/p2o` command.
 *
 * One input string in, one discriminated command out. No `eval`, no shell, no globbing, no variable
 * expansion: quotes only group whitespace, backslash escapes only the next character. Unknown flags,
 * duplicate flags, wrong arity and out-of-range numbers are refused with an explicit code instead of
 * being silently ignored or coerced.
 */
import { InterfaceError } from './types.js';
import type { EntryDepth } from './target-entry.js';
import type { OnboardingProfile } from '../application/onboarding/types.js';

export const PROFILES: readonly OnboardingProfile[] = ['conservative', 'wide', 'ceiling'];
export type AuthorizationBasis = 'owner' | 'written-permission' | 'published-program' | 'public-source-review';
export const BASES: readonly AuthorizationBasis[] = ['owner', 'written-permission', 'published-program', 'public-source-review'];

export type P2OCommand =
  | { verb: 'help' }
  | { verb: 'status'; runId?: string }
  | { verb: 'stop'; runId?: string }
  | { verb: 'resume'; runId?: string }
  | { verb: 'report'; runId?: string }
  | { verb: 'approve'; planId: string }
  | {
    verb: 'start';
    target: string;
    purpose?: string;
    depth: EntryDepth;
    planOnly: boolean;
    budgetUsd?: number;
    concurrency?: number;
    /** Requests for separate HUMAN rights/deadline review, never grants. */
    repositoryScripts?: true;
    stateChanges?: true;
    deadlineMinutes?: number;
    /** `ceiling` profile id for the one-dialog quick consent; absent keeps the default profile. */
    profile?: OnboardingProfile;
    /** Human-selected authorization basis shown in the quick consent dialog. */
    basis?: AuthorizationBasis;
    /** Owned-target convenience: requests BOTH separate rights in one flag, still shown in the dialog. */
    fullRights?: true;
    /** Ask every onboarding question separately instead of the one-dialog quick consent. */
    advanced?: true;
  };

export const LIFECYCLE_VERBS = ['status', 'stop', 'resume', 'report'] as const;
export const DEPTHS: readonly EntryDepth[] = ['quick', 'standard', 'deep'];

const MAX_COMMAND_BYTES = 16_384;
const MAX_ID = 160;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const BUDGET = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const CONCURRENCY = /^[1-9]\d*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
export const MAX_BUDGET_USD = 100_000;
export const MAX_CONCURRENCY = 64;

function invalid(code: string, message: string): InterfaceError {
  return new InterfaceError(code, message);
}

/** Split one raw argument string into tokens. Quotes group; backslash escapes; nothing is executed. */
export function tokenize(input: string): string[] {
  if (typeof input !== 'string') throw invalid('INVALID_ARGUMENT', 'command arguments must be a string');
  if (Buffer.byteLength(input, 'utf8') > MAX_COMMAND_BYTES) throw invalid('INVALID_ARGUMENT', 'command arguments exceed 16KiB');
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let i = 0;
  const push = (): void => { if (started) { tokens.push(current); current = ''; started = false; } };
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { push(); i++; continue; }
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw invalid('UNTERMINATED_QUOTE', 'unterminated single quote');
      current += input.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < input.length) {
        const d = input[i];
        if (d === '\\') {
          const next = input[i + 1];
          if (next === undefined) throw invalid('TRAILING_ESCAPE', 'trailing backslash inside double quotes');
          if (next === '"' || next === '\\' || next === '$' || next === '`') { current += next; i += 2; continue; }
          current += d;
          i++;
          continue;
        }
        if (d === '"') { closed = true; i++; break; }
        current += d;
        i++;
      }
      if (!closed) throw invalid('UNTERMINATED_QUOTE', 'unterminated double quote');
      started = true;
      continue;
    }
    if (ch === '\\') {
      const next = input[i + 1];
      if (next === undefined) throw invalid('TRAILING_ESCAPE', 'trailing backslash');
      current += next;
      started = true;
      i += 2;
      continue;
    }
    if (CONTROL.test(ch)) throw invalid('INVALID_ARGUMENT', 'command arguments contain a control character');
    current += ch;
    started = true;
    i++;
  }
  push();
  return tokens;
}

function runId(value: string): string {
  if (value.length > MAX_ID || !ID.test(value)) throw invalid('INVALID_RUN_ID', `invalid runId "${value.slice(0, 64)}"`);
  return value;
}

function planId(value: string): string {
  if (value.length > MAX_ID || !ID.test(value)) throw invalid('INVALID_PLAN_ID', `invalid planId "${value.slice(0, 64)}"`);
  return value;
}

function parseLifecycle(verb: 'status' | 'stop' | 'resume' | 'report', rest: string[]): P2OCommand {
  if (rest.length > 1) throw invalid('UNEXPECTED_ARGUMENT', `${verb} accepts at most one runId`);
  const value = rest[0];
  if (value === undefined) return { verb };
  if (value === '--help' || value === '-h') return { verb: 'help' };
  if (value.startsWith('-')) throw invalid('UNKNOWN_FLAG', `unknown flag ${value} for ${verb}; it accepts only an optional runId`);
  return { verb, runId: runId(value) };
}

function parseStart(tokens: string[]): P2OCommand {
  const seen = new Set<string>();
  let target: string | undefined;
  let purpose: string | undefined;
  let depth: EntryDepth = 'standard';
  let planOnly = false;
  let budgetUsd: number | undefined;
  let concurrency: number | undefined;
  let repositoryScripts: true | undefined;
  let stateChanges: true | undefined;
  let deadlineMinutes: number | undefined;
  let profile: OnboardingProfile | undefined;
  let basis: AuthorizationBasis | undefined;
  let fullRights: true | undefined;
  let advanced: true | undefined;

  const takeValue = (name: string, inline: string | undefined, index: number): { value: string; next: number } => {
    if (seen.has(name)) throw invalid('DUPLICATE_FLAG', `${name} was given more than once`);
    seen.add(name);
    if (inline !== undefined) {
      if (!inline) throw invalid('MISSING_VALUE', `${name} requires a value`);
      return { value: inline, next: index };
    }
    const value = tokens[index + 1];
    if (value === undefined) throw invalid('MISSING_VALUE', `${name} requires a value`);
    // Only --purpose may legitimately start with "--"; for the other flags that shape is a missing value.
    if (value.startsWith('--') && name !== '--purpose') throw invalid('MISSING_VALUE', `${name} requires a value`);
    return { value, next: index + 1 };
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--help' || token === '-h') return { verb: 'help' };
    if (!token.startsWith('--')) throw invalid('UNEXPECTED_ARGUMENT', `unexpected argument "${token.slice(0, 64)}"`);
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    if (name === '--target') {
      const taken = takeValue('--target', inline, i);
      i = taken.next;
      target = taken.value.trim();
      if (!target) throw invalid('MISSING_TARGET', '--target requires a non-empty value');
      if (target.length > 4096 || CONTROL.test(target)) throw invalid('INVALID_TARGET', '--target contains control characters or is too long');
      continue;
    }
    if (name === '--purpose') {
      const taken = takeValue('--purpose', inline, i);
      i = taken.next;
      purpose = taken.value;
      if (!purpose.length) throw invalid('INVALID_PURPOSE', '--purpose requires a non-empty value');
      if (purpose.length > 4096) throw invalid('INVALID_PURPOSE', '--purpose exceeds 4096 characters');
      if (CONTROL.test(purpose)) throw invalid('INVALID_PURPOSE', '--purpose contains a control character');
      continue;
    }
    if (name === '--depth') {
      const taken = takeValue('--depth', inline, i);
      i = taken.next;
      if (!DEPTHS.includes(taken.value as EntryDepth)) throw invalid('INVALID_DEPTH', `--depth must be one of ${DEPTHS.join('|')}`);
      depth = taken.value as EntryDepth;
      continue;
    }
    if (name === '--budget') {
      const taken = takeValue('--budget', inline, i);
      i = taken.next;
      if (!BUDGET.test(taken.value)) throw invalid('INVALID_BUDGET', '--budget must be a plain positive USD amount such as 5 or 12.50');
      const value = Number(taken.value);
      if (!Number.isFinite(value) || value <= 0) throw invalid('INVALID_BUDGET', '--budget must be greater than 0');
      if (value > MAX_BUDGET_USD) throw invalid('INVALID_BUDGET', `--budget must be at most ${MAX_BUDGET_USD}`);
      budgetUsd = value;
      continue;
    }
    if (name === '--concurrency') {
      const taken = takeValue('--concurrency', inline, i);
      i = taken.next;
      if (!CONCURRENCY.test(taken.value)) throw invalid('INVALID_CONCURRENCY', '--concurrency must be a positive integer');
      const value = Number(taken.value);
      if (value > MAX_CONCURRENCY) throw invalid('INVALID_CONCURRENCY', `--concurrency must be at most ${MAX_CONCURRENCY}`);
      concurrency = value;
      continue;
    }
    if (name === '--repo-scripts' || name === '--state-changes' || name === '--full-rights') {
      if (inline !== undefined) throw invalid('UNEXPECTED_ARGUMENT', `${name} takes no value; it requests a human opt-in dialog`);
      if (seen.has(name)) throw invalid('DUPLICATE_FLAG', `${name} was given more than once`);
      seen.add(name);
      if (name === '--repo-scripts') repositoryScripts = true;
      else if (name === '--state-changes') stateChanges = true;
      else fullRights = true;
      continue;
    }
    if (name === '--profile') {
      const taken = takeValue('--profile', inline, i);
      i = taken.next;
      if (!PROFILES.includes(taken.value as OnboardingProfile)) throw invalid('INVALID_PROFILE', `--profile must be one of ${PROFILES.join('|')}`);
      profile = taken.value as OnboardingProfile;
      continue;
    }
    if (name === '--basis') {
      const taken = takeValue('--basis', inline, i);
      i = taken.next;
      if (!BASES.includes(taken.value as AuthorizationBasis)) throw invalid('INVALID_BASIS', `--basis must be one of ${BASES.join('|')}`);
      basis = taken.value as AuthorizationBasis;
      continue;
    }
    if (name === '--advanced') {
      if (inline !== undefined) throw invalid('UNEXPECTED_ARGUMENT', '--advanced takes no value');
      if (seen.has(name)) throw invalid('DUPLICATE_FLAG', '--advanced was given more than once');
      seen.add(name);
      advanced = true;
      continue;
    }
    if (name === '--deadline') {
      const taken = takeValue('--deadline', inline, i);
      i = taken.next;
      const value = Number(taken.value);
      if (!CONCURRENCY.test(taken.value) || value > 10_080) throw invalid('INVALID_DEADLINE', '--deadline must be 1..10080 minutes from now; expansion requires human consent');
      deadlineMinutes = value;
      continue;
    }
    if (name === '--plan-only') {
      if (inline !== undefined) throw invalid('UNEXPECTED_ARGUMENT', '--plan-only takes no value');
      if (seen.has(name)) throw invalid('DUPLICATE_FLAG', '--plan-only was given more than once');
      seen.add(name);
      planOnly = true;
      continue;
    }
    throw invalid('UNKNOWN_FLAG', `unknown flag ${name}; run /p2o for the accepted grammar`);
  }
  if (target === undefined) throw invalid('MISSING_TARGET', 'a target is required: /p2o --target <local-dir|github-https-repo|http(s)-URL>');
  return { verb: 'start', target, ...(purpose !== undefined ? { purpose } : {}), depth, planOnly,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}), ...(concurrency !== undefined ? { concurrency } : {}),
    ...(repositoryScripts || fullRights ? { repositoryScripts: true } : {}), ...(stateChanges || fullRights ? { stateChanges: true } : {}),
    ...(deadlineMinutes !== undefined ? { deadlineMinutes } : {}), ...(profile !== undefined ? { profile } : {}),
    ...(basis !== undefined ? { basis } : {}), ...(fullRights ? { fullRights } : {}), ...(advanced ? { advanced } : {}) };
}

/** Parse the full `/p2o` argument string into exactly one command. */
export function parseP2OArgs(input: string): P2OCommand {
  const tokens = tokenize(input);
  if (!tokens.length) return { verb: 'help' };
  const first = tokens[0];
  if (first === 'help' || first === '--help' || first === '-h') {
    if (tokens.length > 1) throw invalid('UNEXPECTED_ARGUMENT', 'help takes no arguments');
    return { verb: 'help' };
  }
  if ((LIFECYCLE_VERBS as readonly string[]).includes(first)) {
    return parseLifecycle(first as 'status' | 'stop' | 'resume' | 'report', tokens.slice(1));
  }
  if (first === 'approve') {
    const rest = tokens.slice(1);
    if (rest.length === 0) throw invalid('MISSING_PLAN_ID', 'approve requires a planId: /p2o approve <planId>');
    if (rest.length > 1) throw invalid('UNEXPECTED_ARGUMENT', 'approve accepts exactly one planId');
    if (rest[0].startsWith('-')) throw invalid('MISSING_PLAN_ID', 'approve requires a planId, not a flag');
    return { verb: 'approve', planId: planId(rest[0]) };
  }
  if (first.startsWith('-')) return parseStart(tokens);
  throw invalid('UNKNOWN_VERB', `unknown verb "${first.slice(0, 64)}"; expected status, stop, resume, report, approve, help, or --target`);
}

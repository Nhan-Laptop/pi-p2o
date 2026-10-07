#!/usr/bin/env node
// Opt-in real-Pi skill benchmark runner. It is intentionally outside `npm test` because the
// `run` command spends provider tokens on live models. `plan`, `verify`, `prepare` and `score`
// are hermetic: they never spawn Pi, never contact the network and never read credentials.
//
// Safety contract:
//  - live runs require an explicit `--live` flag; there is no implicit model call
//  - the child Pi process receives the ambient provider environment only; this script never
//    reads `pi auth` output or any credential/agent configuration file, and never prints env
//  - fixtures are synthetic local targets; no external or production target is ever passed
//  - receipts contain hashes, counters, redacted bounded text and evaluator references
//  - raw RPC records, stderr and transcript projections are capped in memory and in receipts
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ARM_IDS, BASELINE_REVISION, DEFAULT_MAX_COST_USD, DEFAULT_MAX_MINUTES, DEFAULT_MAX_TARGET_COMMANDS,
  DEFAULT_MAX_TURNS, DEFAULT_MODEL, DEFAULT_REPS, DEFAULT_SEED, DEFAULT_THINKING, PLAN_SCHEMA,
  buildPlan, copyVariant, discoverFixtures, parseSeed, resolveArms,
} from '../bench/lib/plan.mjs';
import { extractTranscript, redactSecrets, scoreRun, summarizeScores } from '../bench/lib/score.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO = resolve(dirname(SCRIPT_PATH), '..');
export const RUN_SCHEMA = 'p2o-bench-run/1';
export const VERIFY_SCHEMA = 'p2o-bench-verify/1';
const POLL_MS = 750;
const HARD_CAP_MINUTES = 90;
const ASSESSMENT_START_TIMEOUT_MS = 120_000;
const MAX_WORKERS_BOUND = 6;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
export const MAX_RECORDS = 20_000;
export const MAX_RECORD_BYTES = 32 * 1024 * 1024;

export const HELP = `p2o skill benchmark runner (opt-in, live model traffic only with --live)

  node scripts/benchmark-skills.mjs plan    [options]   # hermetic randomized plan receipt
  node scripts/benchmark-skills.mjs verify  [options]   # hermetic fixture + truth checks (host python3)
  node scripts/benchmark-skills.mjs prepare [options]   # materialize baseline revision via git archive
  node scripts/benchmark-skills.mjs run     [options] --live   # real Pi + real P2O Docker sandbox
  node scripts/benchmark-skills.mjs score   <receipt.json>     # re-score a stored run

Arms (methods from planning_update.md Phase 5):
  A  baseline revision ${BASELINE_REVISION}, original 17 skills, no durable-export start flag
  B  improved runtime, same original 17 skills, passes --export when the package supports it
  C  improved runtime plus the three web playbooks and the FastAPI parity overlay

Options:
  --repo <dir>            repository root (default: this checkout)
  --workdir <dir>         run workspaces and prepared arm packages (default: bench/.work)
  --results <dir>         machine receipts (default: bench/results)
  --arm <A,B,C>           arms to run (default: all)
  --fixture <name>        fixture name, repeatable (default: all discovered)
  --variant <list>        vulnerable,fixed (default: both)
  --reps <n>              repetitions per arm/fixture/variant (default: ${DEFAULT_REPS})
  --seed <int|random>     run-order seed, always recorded (default: ${DEFAULT_SEED})
  --model <provider/id>   Pi model (default: ${DEFAULT_MODEL})
  --thinking <level>      off|minimal|low|medium|high (default: ${DEFAULT_THINKING})
  --max-minutes <n>       fixed per-run wall budget (default: ${DEFAULT_MAX_MINUTES})
  --max-cost-usd <n>      per-run cost ceiling when the provider reports cost (default: ${DEFAULT_MAX_COST_USD})
  --max-turns <n>         fixed per-run assistant-turn ceiling (default: ${DEFAULT_MAX_TURNS})
  --max-target-commands <n> fixed per-run p2o_shell+p2o_http ceiling (default: ${DEFAULT_MAX_TARGET_COMMANDS})
  --delegation            allow visible worker panes (default: --solo; needs Herdr)
  --workers <n>           workers when --delegation is set, 1..${MAX_WORKERS_BOUND} (default: 1)
  --start-flag <flag>     explicit additional /p2o start flag, repeatable (overrides arm defaults)
  --no-export             suppress the arm's --export start flag (A never receives it)
  --pi <path>             Pi binary (default: <repo>/node_modules/.bin/pi)
  --baseline-dir <dir>    prepared revision ${BASELINE_REVISION} for arm A (default: bench/.arms/baseline-${BASELINE_REVISION})
  --arm-a-path <path>     explicit arm A package/extension (overrides baseline auto-resolution)
  --arm-b-path <path>     explicit arm B package/extension
  --arm-c-path <path>     explicit arm C package/extension
  --extension-path <path> explicit extension for a single selected arm
  --keep-work             keep run workspaces after the run
  --json                  print machine JSON instead of a short summary

The objective text always comes from the frozen evaluator manifest; the runner accepts no
caller-supplied prompt, and objectives are validated offline for leaked solution terms. Live runs
use the real P2O extension against a local synthetic fixture with the real Docker sandbox. Budgets
are fixed per run, the run order is seeded and recorded, and provider failures are reported
separately, never scored as security negatives.`;

function usageError(message) {
  const error = new Error(message);
  error.code = 'USAGE';
  return error;
}

/** Parse CLI arguments without touching the filesystem, environment or network. */
export function parseArgs(argv) {
  const options = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help',
    repo: DEFAULT_REPO, workdir: undefined, results: undefined,
    arms: undefined, fixtures: [], variants: undefined, reps: DEFAULT_REPS,
    seed: undefined, model: DEFAULT_MODEL, thinking: DEFAULT_THINKING,
    maxMinutes: DEFAULT_MAX_MINUTES, maxCostUsd: DEFAULT_MAX_COST_USD,
    maxTurns: DEFAULT_MAX_TURNS, maxTargetCommands: DEFAULT_MAX_TARGET_COMMANDS,
    delegation: false, workers: 1, pi: undefined, baselineDir: undefined,
    armPaths: {}, extensionPath: undefined, startFlags: [], noExport: false,
    live: false, keepWork: false, json: false, positional: [],
  };
  const rest = options.command === 'help' ? argv : argv.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index];
    if (!raw.startsWith('--')) { options.positional.push(raw); continue; }
    const equal = raw.indexOf('=');
    const key = equal >= 0 ? raw.slice(2, equal) : raw.slice(2);
    const inline = equal >= 0 ? raw.slice(equal + 1) : undefined;
    if (key === 'start-flag' && inline === undefined) {
      // A start flag itself begins with dashes, so consume the next token verbatim.
      const next = rest[index + 1];
      if (typeof next !== 'string' || !next) throw usageError('--start-flag needs a flag value');
      options.startFlags.push(next);
      index += 1;
      continue;
    }
    const value = inline !== undefined ? inline : (rest[index + 1] !== undefined && !rest[index + 1].startsWith('--') ? rest[++index] : true);
    switch (key) {
      case 'repo': options.repo = String(value); break;
      case 'workdir': options.workdir = String(value); break;
      case 'results': options.results = String(value); break;
      case 'arm': options.arms = String(value).split(',').map(item => item.trim()).filter(Boolean); break;
      case 'fixture': options.fixtures.push(String(value)); break;
      case 'variant': options.variants = String(value).split(',').map(item => item.trim()).filter(Boolean); break;
      case 'reps': options.reps = Number(value); break;
      case 'seed': options.seed = String(value); break;
      case 'model': options.model = String(value); break;
      case 'thinking': options.thinking = String(value); break;
      case 'max-minutes': options.maxMinutes = Number(value); break;
      case 'max-cost-usd': options.maxCostUsd = Number(value); break;
      case 'max-turns': options.maxTurns = Number(value); break;
      case 'max-target-commands': options.maxTargetCommands = Number(value); break;
      case 'delegation': options.delegation = true; break;
      case 'workers': options.workers = Number(value); break;
      case 'start-flag': options.startFlags.push(String(value)); break;
      case 'no-export': options.noExport = true; break;
      case 'pi': options.pi = String(value); break;
      case 'baseline-dir': options.baselineDir = String(value); break;
      case 'arm-a-path': options.armPaths.A = String(value); break;
      case 'arm-b-path': options.armPaths.B = String(value); break;
      case 'arm-c-path': options.armPaths.C = String(value); break;
      case 'extension-path': options.extensionPath = String(value); break;
      case 'keep-work': options.keepWork = true; break;
      case 'json': options.json = true; break;
      case 'live': options.live = true; break;
      case 'help': options.command = 'help'; break;
      default: throw usageError(`unknown option --${key}`);
    }
  }
  if (!Number.isInteger(options.reps) || options.reps < 1) throw usageError('--reps must be a positive integer');
  if (!Number.isFinite(options.maxMinutes) || options.maxMinutes < 1 || options.maxMinutes > HARD_CAP_MINUTES) {
    throw usageError(`--max-minutes must be between 1 and ${HARD_CAP_MINUTES}`);
  }
  if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) throw usageError('--max-cost-usd must be > 0');
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 500) throw usageError('--max-turns must be an integer between 1 and 500');
  if (!Number.isInteger(options.maxTargetCommands) || options.maxTargetCommands < 1 || options.maxTargetCommands > 600) throw usageError('--max-target-commands must be an integer between 1 and 600');
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > MAX_WORKERS_BOUND) throw usageError(`--workers must be between 1 and ${MAX_WORKERS_BOUND}`);
  for (const flag of options.startFlags) {
    if (!/^--[a-z][a-z0-9-]{0,30}$/.test(flag)) throw usageError(`--start-flag must look like --flag, got "${flag}"`);
  }
  if (options.arms) {
    const bad = options.arms.filter(arm => !ARM_IDS.includes(arm));
    if (bad.length) throw usageError(`unknown arm(s): ${bad.join(', ')}`);
    if (options.extensionPath && options.arms.length !== 1) throw usageError('--extension-path requires exactly one --arm');
  }
  // There is no arbitrary prompt input: objectives come only from the frozen evaluator manifest.
  if (options.command !== 'score' && options.positional.length) throw usageError(`unexpected argument(s): ${options.positional.join(' ')}`);
  if (options.command === 'score' && options.positional.length > 1) throw usageError('score accepts one receipt path');
  options.repo = resolve(options.repo);
  options.workdir = resolve(options.workdir ?? join(options.repo, 'bench', '.work'));
  options.results = resolve(options.results ?? join(options.repo, 'bench', 'results'));
  options.pi = options.pi ? resolve(options.pi) : join(options.repo, 'node_modules', '.bin', 'pi');
  options.baselineDir = options.baselineDir ? resolve(options.baselineDir) : join(options.repo, 'bench', '.arms', `baseline-${BASELINE_REVISION}`);
  return options;
}

function selectedArmIds(options) {
  const arms = options.arms ?? [...ARM_IDS];
  if (options.extensionPath) options.armPaths[arms[0]] = options.extensionPath;
  return arms;
}

/** Resolve each selected arm independently so one unavailable arm is reported, not hidden. */
async function selectAvailableArms(options) {
  const wanted = selectedArmIds(options);
  const available = [];
  const skipped = [];
  for (const id of wanted) {
    try {
      const resolved = await resolveArms(options.repo, {
        workDir: options.workdir, baselineDir: options.baselineDir, armPaths: options.armPaths, only: [id], prepare: true,
      });
      if (!resolved[id]) throw new Error(`arm ${id} did not resolve`);
      available.push(id);
    } catch (error) {
      skipped.push({ arm: id, reason: redactSecrets(error instanceof Error ? error.message : String(error)) });
    }
  }
  return { available, skipped };
}

async function loadSelectedFixtures(repoRoot, names) {
  const fixtures = await discoverFixtures(repoRoot);
  if (!names.length) return fixtures;
  const wanted = new Set(names);
  const selected = fixtures.filter(fixture => wanted.has(fixture.name));
  const missing = [...wanted].filter(name => !fixtures.some(fixture => fixture.name === name));
  if (missing.length) throw usageError(`unknown fixture(s): ${missing.join(', ')}`);
  return selected;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Read a child stream as UTF-8 without readline (U+2028/U+2029 are valid JSON string data). */
class LineReader {
  constructor(stream, onLine) {
    this.buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', text => {
      this.buffer += text;
      for (;;) {
        const index = this.buffer.indexOf('\n');
        if (index < 0) break;
        let line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.trim()) onLine(line);
      }
    });
  }
}

/**
 * Bounded RPC record store: keeps a capped raw log plus exact counters, so a long run cannot
 * exhaust memory while validity checks (settle, errors, budgets, details) stay complete.
 */
export class BoundedRecords {
  constructor({ maxRecords = MAX_RECORDS, maxBytes = MAX_RECORD_BYTES } = {}) {
    this.stored = [];
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.summary = {
      recordsSeen: 0, recordsStored: 0, recordsDropped: 0, logTruncated: false,
      settled: false, settledCount: 0, turns: 0, targetCommands: 0,
      evidenceIds: [], toolDetails: [], providerErrors: [], extensionErrors: [], protocolErrors: [],
    };
  }

  push(record) {
    const summary = this.summary;
    summary.recordsSeen += 1;
    if (record?.type === 'agent_settled') { summary.settled = true; summary.settledCount += 1; }
    if (record?.type === 'turn_end') summary.turns += 1;
    if (record?.type === 'tool_execution_start' && (record.toolName === 'p2o_shell' || record.toolName === 'p2o_http')) summary.targetCommands += 1;
    if (record?.type === 'extension_error') pushBounded(summary.extensionErrors, redactSecrets(record.error), 50);
    if (record?.protocolError) pushBounded(summary.protocolErrors, redactSecrets(String(record.protocolError).slice(0, 500)), 50);
    if (record?.type === 'auto_retry_end' && record.success === false) pushBounded(summary.providerErrors, redactSecrets(record.finalError ?? 'auto retry failed'), 50);
    if (record?.type === 'message_end' && record.message?.role === 'assistant' && (record.message.stopReason === 'error' || record.message.errorMessage)) {
      pushBounded(summary.providerErrors, redactSecrets(record.message.errorMessage ?? record.message.stopReason), 50);
    }
    if (record?.type === 'tool_execution_end') {
      const details = record.result?.details ?? null;
      const evidenceId = details?.evidenceId;
      if (typeof evidenceId === 'string' && evidenceId) pushBounded(summary.evidenceIds, evidenceId.toLowerCase(), 400);
      if (record.toolName === 'p2o_finish' || record.toolName === 'p2o_candidate' || evidenceId) {
        if (summary.toolDetails.length < 500) summary.toolDetails.push({ toolName: record.toolName ?? '', details });
      }
    }
    const size = safeSize(record);
    if (this.stored.length >= this.maxRecords || this.bytes + size > this.maxBytes) {
      summary.recordsDropped += 1;
      summary.logTruncated = true;
    } else {
      this.stored.push(record);
      this.bytes += size;
    }
    summary.recordsStored = this.stored.length;
  }
}

function pushBounded(array, value, limit) {
  if (typeof value !== 'string' || !value || array.includes(value)) return;
  if (array.length >= limit) return;
  array.push(value);
}

function safeSize(record) {
  try { return JSON.stringify(record).length + 1; } catch { return 1024; }
}

/** Minimal JSONL RPC client for a real Pi subprocess. */
export class PiRpc {
  constructor(child, { onRecord, onDialog } = {}) {
    this.child = child;
    this.store = new BoundedRecords();
    this.stderr = '';
    this.pending = new Map();
    this.sequence = 0;
    this.exited = false;
    this.onDialog = onDialog;
    this.closed = new Promise(resolvePromise => child.once('close', () => {
      this.exited = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error(`Pi exited before responding: ${this.stderr.slice(-500)}`));
      this.pending.clear();
      resolvePromise();
    }));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { this.stderr += text; if (this.stderr.length > 200_000) this.stderr = this.stderr.slice(-200_000); });
    new LineReader(child.stdout, line => {
      let record;
      try { record = JSON.parse(line); } catch { record = { protocolError: line.slice(0, 1000) }; }
      this.store.push(record);
      onRecord?.(record);
      if (record.type === 'response' && record.id) {
        const waiter = this.pending.get(record.id);
        if (waiter) { this.pending.delete(record.id); waiter.resolve(record); }
      } else if (record.type === 'extension_ui_request') {
        this.onDialog?.(record);
      }
    });
  }

  get records() { return this.store.stored; }
  get recordSummary() { return this.store.summary; }

  request(type, fields = {}, timeoutMs = 60_000) {
    if (this.exited) return Promise.reject(new Error(`Pi already exited: ${this.stderr.slice(-500)}`));
    const id = `bench-${++this.sequence}`;
    let timer;
    return Promise.race([
      new Promise((resolvePromise, reject) => {
        this.pending.set(id, { resolve: resolvePromise, reject });
        this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout for ${type} after ${timeoutMs}ms`)); }, timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** Answer extension UI dialogs mechanically; every request is recorded by the caller. */
  answerDialogs({ autoConfirm = /Start authorized assessment\?/ } = {}) {
    const previous = this.onDialog;
    this.onDialog = request => {
      previous?.(request);
      try {
        if (request.method === 'confirm') {
          this.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: request.id, confirmed: Boolean(autoConfirm?.test(request.title ?? '')) })}\n`);
        } else if (['select', 'input', 'editor'].includes(request.method)) {
          this.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: request.id, cancelled: true })}\n`);
        }
      } catch { /* the process is closing */ }
    };
  }

  async close(graceMs = 15_000) {
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const exited = await Promise.race([this.closed.then(() => true), delay(graceMs).then(() => false)]);
    if (!exited) {
      this.child.kill('SIGTERM');
      await Promise.race([this.closed, delay(5000)]);
    }
  }
}

async function runCommand(command, args, { cwd, env, timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; });
    child.stderr.on('data', text => { stderr += text; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}

async function listBenchContainers() {
  try {
    const { code, stdout } = await runCommand('docker', ['container', 'ls', '--all', '--filter', 'label=pi-p2o=minimal', '--format', '{{.Names}}'], { timeoutMs: 20_000 });
    if (code !== 0) return { available: false, names: [] };
    return { available: true, names: stdout.split('\n').map(name => name.trim()).filter(Boolean) };
  } catch {
    return { available: false, names: [] };
  }
}

function newLeakedContainers(before, after) {
  const known = new Set(before.names);
  return after.names.filter(name => !known.has(name));
}

function piVersion(piBinary) {
  try { return execFileSync(piBinary, ['--version'], { encoding: 'utf8' }).trim(); } catch { return null; }
}

/**
 * Child environment: inherit the ambient provider configuration but drop stale markers copied
 * from the parent session's shell; never print or serialize any of it.
 */
function childEnv() {
  const env = { ...process.env, PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' };
  for (const key of ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL']) delete env[key];
  return env;
}

function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n');
}

/** Effective /p2o start flags: arm defaults, or explicit override, never for a suppressed export. */
export function p2oStartFlags(arm, { startFlags = [], noExport = false } = {}) {
  let flags = arm?.startFlags ?? [];
  if (noExport) flags = flags.filter(flag => flag !== '--export');
  if (startFlags.length) flags = [...new Set(startFlags)];
  return flags;
}

/** Read a finish export only when it is a regular file inside the run workspace. */
export async function readExportFile({ exportPath, workspaceDir, maxBytes = MAX_EXPORT_BYTES }) {
  if (typeof exportPath !== 'string' || !exportPath.trim()) throw new Error('missing export path');
  const root = resolve(workspaceDir);
  const target = resolve(exportPath);
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel.startsWith('..') || rel.split(/[\\/]/).includes('..')) {
    throw new Error(`export path outside the run workspace: ${exportPath}`);
  }
  const info = await stat(target);
  if (!info.isFile()) throw new Error('export path is not a regular file');
  if (info.size > maxBytes) throw new Error(`export exceeds ${maxBytes} bytes`);
  const bytes = await readFile(target);
  return { path: target, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: JSON.parse(bytes.toString('utf8')) };
}

/** Extract candidate/proof references from the durable export payload (version 2 records). */
export function exportDataFrom(payload) {
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const candidates = records.filter(record => record?.kind === 'candidate').map(record => record.data ?? {});
  const evidenceIds = records.filter(record => record?.kind === 'evidence' && typeof record.id === 'string').map(record => record.id);
  return { candidates, evidenceIds, runId: payload?.runId ?? null, version: payload?.version ?? null };
}

function exportPathFrom(extraction) {
  const detailsPath = extraction.finishDetails?.exportPath;
  if (typeof detailsPath === 'string' && detailsPath) return detailsPath;
  const text = `${extraction.finishText ?? ''}`;
  const match = /Evidence export:\s*(\S[^\n]*?)(?:\n|$)/.exec(text);
  return match ? match[1].trim() : null;
}

/** The live half: spawn real Pi, drive the real extension through RPC, then score the run. */
async function executeRun({ plan, run, truth, options, suiteId, resultsDir }) {
  const arm = plan.arms[run.arm];
  const runDir = await mkdtemp(join(options.workdir, `live-${run.arm}-`));
  const target = join(runDir, 'target');
  const source = await copyVariant(run.sourceDir, target);
  const containersBefore = await listBenchContainers();
  const dialogs = [];
  const notifications = [];
  const startFlags = p2oStartFlags(arm, options);
  const p2oCommand = `/p2o --target ./target${options.delegation ? ` --workers ${options.workers}` : ' --solo'}${startFlags.length ? ` ${startFlags.join(' ')}` : ''}`;
  const args = ['--no-extensions', '-e', arm.extensionPath, '--no-skills', '--no-prompt-templates', '--no-themes',
    '--no-context-files', '--no-approve', '--no-session', '--mode', 'rpc', '--model', options.model, '--thinking', options.thinking];
  const child = spawn(options.pi, args, { cwd: runDir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => { /* closed pipes are handled by the request timeout/exit path */ });
  const startedAt = Date.now();
  const checks = {
    exitOk: null, providerFailure: false, budgetExceeded: false, protocolDirty: false,
    assessmentStarted: false, cleanupVerified: false, turnsUsed: 0, targetCommandsUsed: 0, budget: null,
  };
  let outcome = 'transport_error';
  let rpc;
  try {
    rpc = new PiRpc(child, { onDialog: request => dialogs.push({ method: request.method, title: request.title }) });
    rpc.answerDialogs();
    await rpc.request('get_state', {}, 30_000);
    const prompt = await rpc.request('prompt', { message: p2oCommand }, 30_000);
    if (!prompt.success) throw new Error(`prompt rejected: ${prompt.error}`);

    const readMessages = async () => (await rpc.request('get_messages', {}, 30_000)).data?.messages ?? [];
    let messages = [];
    for (let waited = 0; waited < ASSESSMENT_START_TIMEOUT_MS; waited += POLL_MS) {
      messages = await readMessages();
      if (messages.some(message => message.role === 'user' && textOfMessage(message).includes('P2O ASSESSMENT'))) { checks.assessmentStarted = true; break; }
      if (rpc.recordSummary.extensionErrors.length) break;
      await delay(POLL_MS);
    }
    if (checks.assessmentStarted) {
      // The fixture objective is delivered after the assessment brief, identical for every arm.
      await rpc.request('follow_up', { message: run.objective }, 30_000);
    } else {
      outcome = 'no_assessment';
    }

    let finishSeen = false;
    let settledAtFinish = 0;
    const deadline = startedAt + options.maxMinutes * 60_000;
    let lastStatsAt = 0;
    if (checks.assessmentStarted) {
      for (;;) {
        await delay(POLL_MS);
        messages = await readMessages();
        const finish = messages.findIndex(message => message.role === 'toolResult' && message.toolName === 'p2o_finish');
        if (finish >= 0 && !finishSeen) { finishSeen = true; settledAtFinish = rpc.recordSummary.settledCount; }
        checks.turnsUsed = Math.max(checks.turnsUsed, rpc.recordSummary.turns);
        checks.targetCommandsUsed = rpc.recordSummary.targetCommands;
        if (finishSeen) {
          const reportAfter = messages.slice(finish + 1).some(message => message.role === 'assistant' && textOfMessage(message).trim());
          if (reportAfter || rpc.recordSummary.settledCount > settledAtFinish) { outcome = 'finished'; break; }
        }
        if (messages.some(message => message.role === 'assistant' && (message.stopReason === 'error' || message.errorMessage))) {
          checks.providerFailure = true; outcome = 'provider_error'; break;
        }
        if (checks.turnsUsed > options.maxTurns) {
          checks.budgetExceeded = true; checks.budget = 'turns'; outcome = 'turn_budget';
          await rpc.request('abort', {}, 30_000).catch(() => {});
          break;
        }
        if (checks.targetCommandsUsed > options.maxTargetCommands) {
          checks.budgetExceeded = true; checks.budget = 'target_commands'; outcome = 'command_budget';
          await rpc.request('abort', {}, 30_000).catch(() => {});
          break;
        }
        const now = Date.now();
        if (now > deadline) {
          checks.budgetExceeded = true; checks.budget = 'wall_clock'; outcome = 'timeout';
          await rpc.request('abort', {}, 30_000).catch(() => {});
          break;
        }
        if (now - lastStatsAt > 30_000) {
          lastStatsAt = now;
          try {
            const stats = (await rpc.request('get_session_stats', {}, 20_000)).data;
            const cost = typeof stats?.cost === 'number' ? stats.cost : 0;
            if (cost > options.maxCostUsd) {
              checks.budgetExceeded = true; checks.budget = 'cost'; outcome = 'cost_budget';
              await rpc.request('abort', {}, 30_000).catch(() => {});
              break;
            }
          } catch { /* stats are advisory */ }
        }
      }
    }

    const messagesFinal = await readMessages();
    let stats = null;
    try { stats = (await rpc.request('get_session_stats', {}, 20_000)).data; } catch { /* optional */ }
    let htmlPath = null;
    try {
      const exported = await rpc.request('export_html', { outputPath: join(runDir, 'session.html') }, 20_000);
      htmlPath = exported.success ? join(runDir, 'session.html') : null;
    } catch { /* optional */ }
    checks.protocolDirty = rpc.recordSummary.protocolErrors.length > 0 || rpc.recordSummary.extensionErrors.length > 0;
    checks.exitOk = true;

    const extraction = extractTranscript({
      messages: messagesFinal, records: rpc.records, recordSummary: rpc.recordSummary,
      stats, dialogs, notifications, htmlPath,
    });
    if (extraction.providerErrors.length) checks.providerFailure = true;
    checks.cleanupVerified = extraction.cleanupVerified;

    // Preserve the durable export before the workspace is removed.
    let exportInfo = { exportPath: null, copiedPath: null, bytes: null, sha256: null, candidates: 0, evidence: 0, error: null };
    let exportData = null;
    const exportPath = exportPathFrom(extraction);
    if (extraction.finishDetails?.exportError) exportInfo.error = String(extraction.finishDetails.exportError);
    if (exportPath) {
      exportInfo.exportPath = exportPath;
      try {
        const captured = await readExportFile({ exportPath, workspaceDir: runDir });
        const copiedPath = join(resultsDir, `${suiteId}.${run.orderIndex}-${run.runId}.export.json`);
        await mkdir(resultsDir, { recursive: true });
        await writeFile(copiedPath, JSON.stringify(captured.data, null, 2));
        exportData = exportDataFrom(captured.data);
        exportInfo = { ...exportInfo, copiedPath, bytes: captured.bytes, sha256: captured.sha256, candidates: exportData.candidates.length, evidence: exportData.evidenceIds.length };
      } catch (error) {
        exportInfo.error = redactSecrets(error instanceof Error ? error.message : String(error));
      }
    }
    await rpc.close();

    const containersAfter = await listBenchContainers();
    const leakedContainers = newLeakedContainers(containersBefore, containersAfter);
    if (leakedContainers.length) checks.cleanupVerified = false;
    const finishedAt = Date.now();
    const score = scoreRun({ truth, variant: run.variant, extraction, checks: { ...checks, leakedContainers }, exportData });
    const receipt = {
      schema: RUN_SCHEMA,
      suiteId,
      runId: run.runId,
      orderIndex: run.orderIndex,
      arm: jsonSafe(arm),
      fixture: { name: run.fixture, variant: run.variant, objective: run.objective, sourceHash: source.hash, truthSha256: run.truthSha256, truthPath: run.truthPath ?? null },
      config: {
        model: options.model, thinking: options.thinking, maxMinutes: options.maxMinutes, maxCostUsd: options.maxCostUsd,
        maxTurns: options.maxTurns, maxTargetCommands: options.maxTargetCommands,
        delegation: options.delegation, workers: options.workers, piBinary: options.pi, piVersion: piVersion(options.pi), seed: plan.seed,
      },
      p2oCommand,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      wallMs: finishedAt - startedAt,
      outcome,
      checks: { ...checks, containersBefore: containersBefore.names, containersAfter: containersAfter.names, leakedContainers },
      usage: extraction.usage,
      export: exportInfo,
      score,
      extraction: {
        counts: extraction.counts, records: extraction.records,
        skillReads: extraction.skillReads, skillLists: extraction.skillLists,
        candidates: extraction.candidates.map(call => ({ tool: call.name, args: redactSecrets(JSON.stringify(call.args)) })),
        evidenceIds: extraction.evidenceIds, dialogs: extraction.dialogs, notifications: extraction.notifications.slice(-40),
        providerErrors: extraction.providerErrors, extensionErrors: extraction.extensionErrors, protocolErrors: extraction.protocolErrors,
        cleanupVerified: extraction.cleanupVerified, finishSeen: extraction.finishSeen, settled: extraction.settled,
        finishDetails: extraction.finishDetails ? jsonSafe(extraction.finishDetails) : null,
        evidenceTextTruncated: extraction.evidenceTextTruncated,
      },
      claimText: extraction.claimText.slice(0, 256 * 1024),
      evidenceText: extraction.evidenceText.slice(0, 512 * 1024),
      stderrTail: redactSecrets(rpc.stderr.slice(-4000)),
      workspace: { dir: runDir, target, sourceFiles: source.files.length, htmlPath },
    };
    await writeJson(join(resultsDir, `${suiteId}.${run.orderIndex}-${run.runId}.json`), receipt);
    await writeFile(join(resultsDir, `${suiteId}.${run.orderIndex}-${run.runId}.messages.json`), `${JSON.stringify(messagesFinal, null, 2)}\n`);
    if (options.keepWork) {
      await writeJson(join(runDir, 'receipt.json'), receipt);
      await writeFile(join(runDir, 'final-report.txt'), `${extraction.finalReport}\n`);
    }
    return receipt;
  } catch (error) {
    checks.exitOk = false;
    const containersAfter = await listBenchContainers();
    return {
      schema: RUN_SCHEMA, suiteId, runId: run.runId, orderIndex: run.orderIndex, outcome: 'transport_error',
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
      stderrTail: redactSecrets(rpc?.stderr?.slice(-4000) ?? ''),
      checks: { ...checks, leakedContainers: newLeakedContainers(containersBefore, containersAfter) },
      startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), wallMs: Date.now() - startedAt,
      arm: jsonSafe(arm), fixture: { name: run.fixture, variant: run.variant, sourceHash: source.hash, truthSha256: run.truthSha256 },
    };
  } finally {
    if (rpc) await rpc.close().catch(() => {});
    else { try { child.stdin.end(); } catch { /* closed */ } try { child.kill('SIGTERM'); } catch { /* closed */ } }
    if (!options.keepWork) await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) {
    console.error(`error: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.command === 'help') { console.log(HELP); return 0; }
  if (!existsSync(join(options.repo, 'package.json'))) { console.error(`error: --repo does not look like the pi-p2o checkout: ${options.repo}`); return 2; }

  try {
    if (options.command === 'prepare') return await prepareBaseline(options);
    if (options.command === 'plan') return await planCommand(options);
    if (options.command === 'verify') return await verifyCommand(options);
    if (options.command === 'score') return await scoreCommand(options);
    if (options.command === 'run') return await runCommandLive(options);
  } catch (error) {
    if (error?.code === 'USAGE') { console.error(`error: ${error.message}`); return 2; }
    throw error;
  }
  console.error(`error: unknown command "${options.command}"\n\n${HELP}`);
  return 2;
}

function requirePi(options) {
  if (!existsSync(options.pi)) throw usageError(`Pi binary not found: ${options.pi}; pass --pi <path>`);
}

function planBudgets(options) {
  return {
    maxMinutes: options.maxMinutes, maxCostUsd: options.maxCostUsd,
    maxTurns: options.maxTurns, maxTargetCommands: options.maxTargetCommands,
    delegation: options.delegation, workers: options.workers,
  };
}

async function planCommand(options) {
  const fixtures = await loadSelectedFixtures(options.repo, options.fixtures);
  requirePi(options);
  const { seed } = parseSeed(options.seed);
  const { available, skipped } = await selectAvailableArms(options);
  if (!available.length) throw usageError(`no selected arm could be resolved:\n${skipped.map(entry => `  ${entry.arm}: ${entry.reason}`).join('\n')}`);
  const plan = await buildPlan({
    repoRoot: options.repo, workDir: options.workdir, fixtures, arms: available,
    variants: options.variants ?? ['vulnerable', 'fixed'], reps: options.reps, seed,
    model: options.model, thinking: options.thinking,
    maxMinutes: options.maxMinutes, maxCostUsd: options.maxCostUsd,
    maxTurns: options.maxTurns, maxTargetCommands: options.maxTargetCommands,
    delegation: options.delegation, workers: options.workers, baselineDir: options.baselineDir, armPaths: options.armPaths,
  });
  const receipt = {
    schema: PLAN_SCHEMA, command: 'plan', createdAt: plan.createdAt, repoRoot: options.repo,
    seed: plan.seed, model: plan.model, thinking: plan.thinking, budgets: plan.budgets, reps: plan.reps,
    arms: jsonSafe(plan.arms), fixtures: jsonSafe(plan.fixtures), skippedArms: skipped, runCount: plan.runCount,
    order: plan.runs.map(run => `#${run.orderIndex} ${run.arm} ${run.fixture}/${run.variant} r${run.rep}`),
    runs: plan.runs,
  };
  await writeJson(join(options.results, `plan-${Date.now()}.json`), receipt);
  if (options.json) console.log(JSON.stringify(receipt, null, 2));
  else {
    console.log(`plan: ${plan.runCount} runs (${plan.armIds.join('/')} x ${fixtures.length} fixtures x ${plan.variants.join('/')} x ${plan.reps} reps, seed ${plan.seed})`);
    for (const [id, arm] of Object.entries(plan.arms)) console.log(`  arm ${id}: ${arm.label} · ${arm.skills.length} skills · flags [${(arm.startFlags ?? []).join(' ') || 'none'}] · ${arm.extensionPath}`);
    for (const entry of skipped) console.log(`  arm ${entry.arm}: SKIPPED (${entry.reason})`);
    for (const run of plan.runs) console.log(`  #${run.orderIndex} ${run.arm} ${run.fixture}/${run.variant} r${run.rep}`);
  }
  return 0;
}

async function verifyCommand(options) {
  const fixtures = await loadSelectedFixtures(options.repo, options.fixtures);
  const results = [];
  let failed = 0;
  for (const fixture of fixtures) {
    for (const variant of (options.variants ?? ['vulnerable', 'fixed'])) {
      const probe = fixture.truth.probe;
      if (!probe) { results.push({ fixture: fixture.name, variant, probe: 'source-only', ok: true }); continue; }
      const parts = probe.command.split(' ');
      const executed = await runCommand(parts[0], parts.slice(1), { cwd: join(fixture.dir, variant), timeoutMs: 60_000 })
        .catch(error => ({ code: -1, stdout: '', stderr: String(error) }));
      const expectedExit = probe.expected_exit?.[variant];
      const observedLines = `${executed.stdout}\n${executed.stderr}`;
      const missing = [];
      for (const expected of probe.expected_failing_cells?.[variant] ?? []) if (!observedLines.includes(expected)) missing.push(expected);
      for (const expected of probe.expected_failing_paths?.[variant] ?? []) if (!observedLines.includes(expected)) missing.push(expected);
      for (const expected of probe.expected_contexts?.[variant] ?? []) if (!observedLines.includes(expected)) missing.push(expected);
      const ok = executed.code === expectedExit && missing.length === 0;
      if (!ok) failed += 1;
      results.push({ fixture: fixture.name, variant, probe: probe.command, expectedExit, observedExit: executed.code, missing, ok });
    }
  }
  const receipt = {
    schema: VERIFY_SCHEMA, command: 'verify', createdAt: new Date().toISOString(), repoRoot: options.repo,
    fixtureHashes: fixtures.map(fixture => ({ name: fixture.name, truthSha256: fixture.truthSha256, variants: Object.fromEntries(Object.entries(fixture.variants).map(([variant, tree]) => [variant, tree.hash])) })),
    results, failed,
  };
  await writeJson(join(options.results, `verify-${Date.now()}.json`), receipt);
  if (options.json) console.log(JSON.stringify(receipt, null, 2));
  else {
    for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.fixture}/${result.variant}${result.probe === 'source-only' ? ' (source-only)' : ` exit ${result.observedExit} (expected ${result.expectedExit})`}${result.missing?.length ? ` missing: ${result.missing.join(', ')}` : ''}`);
    console.log(failed ? `verification failed for ${failed} fixture variant(s)` : `verification passed for ${results.length} fixture variant(s)`);
  }
  return failed ? 1 : 0;
}

async function prepareBaseline(options) {
  const revision = BASELINE_REVISION;
  const destination = options.baselineDir;
  if (existsSync(join(destination, 'extensions', 'p2o', 'index.ts'))) {
    console.log(`baseline already prepared: ${destination}`);
    return 0;
  }
  await mkdir(destination, { recursive: true });
  const git = spawn('git', ['archive', '--format=tar', revision], { cwd: options.repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const tar = spawn('tar', ['-x', '-C', destination], { stdio: ['pipe', 'ignore', 'pipe'] });
  git.stdout.pipe(tar.stdin);
  const [gitCode, tarCode] = await Promise.all([
    new Promise(resolvePromise => git.once('close', resolvePromise)),
    new Promise(resolvePromise => tar.once('close', resolvePromise)),
  ]);
  if (gitCode !== 0 || tarCode !== 0) {
    await rm(destination, { recursive: true, force: true });
    console.error(`error: could not materialize revision ${revision} (git ${gitCode}, tar ${tarCode})`);
    return 1;
  }
  const skills = (await readdir(join(destination, 'skills'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && existsSync(join(destination, 'skills', entry.name, 'SKILL.md')))
    .map(entry => entry.name).sort();
  if (skills.length !== 17) { console.error(`error: expected 17 baseline skills, found ${skills.length}`); return 1; }
  await writeJson(join(destination, '.prepared.json'), { revision, skills, preparedAt: new Date().toISOString() });
  console.log(`prepared ${revision} at ${destination} (${skills.length} skills; node_modules resolution walks to the repo)`);
  return 0;
}

async function runCommandLive(options) {
  if (!options.live) {
    console.error('refusing to start live model traffic without --live. Review the plan first:\n' +
      '  node scripts/benchmark-skills.mjs plan [same options]\n' +
      'then re-run the same command with --live. Provider charges apply; fixtures are local only.');
    return 2;
  }
  const fixtures = await loadSelectedFixtures(options.repo, options.fixtures);
  requirePi(options);
  const { seed } = parseSeed(options.seed);
  const { available, skipped } = await selectAvailableArms(options);
  if (!available.length) throw usageError(`no selected arm could be resolved:\n${skipped.map(entry => `  ${entry.arm}: ${entry.reason}`).join('\n')}`);
  const plan = await buildPlan({
    repoRoot: options.repo, workDir: options.workdir, fixtures, arms: available,
    variants: options.variants ?? ['vulnerable', 'fixed'], reps: options.reps, seed,
    model: options.model, thinking: options.thinking,
    maxMinutes: options.maxMinutes, maxCostUsd: options.maxCostUsd,
    maxTurns: options.maxTurns, maxTargetCommands: options.maxTargetCommands,
    delegation: options.delegation, workers: options.workers, baselineDir: options.baselineDir, armPaths: options.armPaths,
  });
  const truthByFixture = new Map(fixtures.map(fixture => [fixture.name, fixture.truth]));
  const suiteId = `suite-${new Date().toISOString().replace(/[:.]/g, '-')}-seed${plan.seed}`;
  await writeJson(join(options.results, `${suiteId}.plan.json`), {
    schema: PLAN_SCHEMA, suiteId, seed: plan.seed, model: plan.model, thinking: plan.thinking,
    budgets: plan.budgets, controls: { maxTurns: options.maxTurns, maxTargetCommands: options.maxTargetCommands },
    arms: jsonSafe(plan.arms), fixtures: jsonSafe(plan.fixtures), skippedArms: skipped,
    startFlags: Object.fromEntries(Object.entries(plan.arms).map(([id, arm]) => [id, p2oStartFlags(arm, options)])),
    runs: plan.runs,
  });
  const scores = [];
  const receipts = [];
  console.log(`suite ${suiteId}: ${plan.runCount} runs, model ${plan.model}, budget ${options.maxMinutes} min / $${options.maxCostUsd} / ${options.maxTurns} turns / ${options.maxTargetCommands} target commands per run`);
  for (const run of plan.runs) {
    const started = Date.now();
    const truth = truthByFixture.get(run.fixture);
    const receipt = await executeRun({ plan, run, truth, options, suiteId, resultsDir: options.results });
    receipts.push(receipt);
    if (receipt.score) {
      scores.push({ arm: run.arm, ...receipt.score, outcome: receipt.outcome, usage: receipt.usage, wallMs: receipt.wallMs, costUsd: receipt.usage?.cost ?? null });
    }
    const verdict = receipt.score
      ? `recall=${receipt.score.metrics.recall.toFixed(2)} precision=${receipt.score.metrics.precision.toFixed(2)} valid=${receipt.score.validity.runValid}`
      : `outcome=${receipt.outcome}`;
    console.log(`#${run.orderIndex} ${run.arm} ${run.fixture}/${run.variant} r${run.rep}: ${receipt.outcome} ${verdict} (${Math.round((Date.now() - started) / 1000)}s)`);
  }
  const budgetOutcomes = receipts.filter(receipt => receipt.checks?.budgetExceeded).length;
  const summary = {
    schema: 'p2o-bench-summary/1', suiteId, createdAt: new Date().toISOString(), seed: plan.seed,
    model: plan.model, thinking: plan.thinking, budgets: plan.budgets,
    controls: { maxTurns: options.maxTurns, maxTargetCommands: options.maxTargetCommands },
    arms: summarizeScores(scores),
    invalidRuns: receipts.filter(receipt => !receipt.score?.validity?.runValid).map(receipt => ({ runId: receipt.runId, outcome: receipt.outcome, providerFailure: receipt.checks?.providerFailure })),
    providerFailures: receipts.filter(receipt => receipt.checks?.providerFailure || receipt.outcome === 'provider_error').map(receipt => receipt.runId),
    budgetOutcomes,
    costAvailableRuns: receipts.filter(receipt => receipt.usage?.costAvailable).length,
    leakedContainers: receipts.flatMap(receipt => (receipt.checks?.leakedContainers ?? []).map(name => ({ runId: receipt.runId, name }))),
    exportFailures: receipts.filter(receipt => receipt.export?.error).map(receipt => ({ runId: receipt.runId, error: receipt.export.error })),
  };
  await writeJson(join(options.results, `${suiteId}.summary.json`), summary);
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`summary written to ${join(options.results, `${suiteId}.summary.json`)}`);
  return summary.leakedContainers.length ? 1 : 0;
}

async function scoreCommand(options) {
  const receiptPath = options.positional[0];
  if (!receiptPath) { console.error('error: score needs a receipt.json path'); return 2; }
  const absolute = resolve(receiptPath);
  const receipt = JSON.parse(await readFile(absolute, 'utf8'));
  if (receipt.schema !== RUN_SCHEMA) { console.error(`error: not a ${RUN_SCHEMA} receipt`); return 2; }
  const allFixtures = await discoverFixtures(options.repo);
  const match = allFixtures.find(entry => entry.name === receipt.fixture.name);
  if (!match) { console.error(`error: fixture ${receipt.fixture.name} not found`); return 2; }
  const messagesPath = absolute.replace(/\.json$/, '.messages.json');
  const messages = existsSync(messagesPath) ? JSON.parse(await readFile(messagesPath, 'utf8')) : [];
  let exportData = null;
  if (receipt.export?.copiedPath && existsSync(receipt.export.copiedPath)) {
    try { exportData = exportDataFrom(JSON.parse(await readFile(receipt.export.copiedPath, 'utf8'))); } catch { exportData = null; }
  }
  const extraction = extractTranscript({
    messages, records: [], recordSummary: receipt.extraction?.records ? { ...receipt.extraction.records, toolDetails: [] } : null,
    stats: receipt.usage, dialogs: receipt.extraction?.dialogs, notifications: receipt.extraction?.notifications,
    htmlPath: receipt.workspace?.htmlPath,
  });
  const score = scoreRun({
    truth: match.truth, variant: receipt.fixture.variant, extraction, exportData,
    checks: {
      leakedContainers: receipt.checks?.leakedContainers ?? [], providerFailure: receipt.checks?.providerFailure,
      budgetExceeded: receipt.checks?.budgetExceeded, protocolDirty: receipt.checks?.protocolDirty, exitOk: receipt.checks?.exitOk,
    },
  });
  const outPath = join(options.results, `${receipt.suiteId ?? 'suite'}.${receipt.orderIndex}-${receipt.runId}.rescored.json`);
  await writeJson(outPath, { ...receipt, score, rescoredAt: new Date().toISOString(), scorer: 'lexical-v1' });
  console.log(`re-scored ${receipt.runId}: recall=${score.metrics.recall.toFixed(2)} precision=${score.metrics.precision.toFixed(2)} evidence=${score.metrics.evidenceReproducibility.toFixed(2)} valid=${score.validity.runValid} -> ${outPath}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const code = await main().catch(error => { console.error(`error: ${error.stack ?? error}`); return 1; });
  process.exitCode = code;
}

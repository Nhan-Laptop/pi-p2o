// Hermetic planning for the real-Pi skill benchmark. This module never spawns a model,
// reads credentials or touches the network: it discovers evaluator fixtures, prepares the
// pinned arm packages and produces the randomized run plan that the live runner executes.
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const PLAN_SCHEMA = 'p2o-bench-plan/1';
export const TRUTH_SCHEMA = 'p2o-bench-truth/1';
export const BASELINE_REVISION = '4321f2b';
export const DEFAULT_MODEL = 'deepseek/deepseek-flash';
export const DEFAULT_THINKING = 'off';
export const DEFAULT_REPS = 3;
export const DEFAULT_MAX_MINUTES = 25;
export const DEFAULT_MAX_COST_USD = 3;
export const DEFAULT_MAX_TURNS = 60;
export const DEFAULT_MAX_TARGET_COMMANDS = 120;
export const DEFAULT_SEED = 1;

/** The library at revision 4321f2b: exactly these 17 technique skills, no catalog sidecar. */
export const ORIGINAL_SKILLS = [
  'attack-surface-mapping', 'authorization-auditing', 'binary-auditing', 'compiler-invariant-auditing',
  'data-flow-analysis', 'deserialization-and-dispatch-auditing', 'dynamic-analysis', 'exploitability-assessment',
  'fuzzing', 'memory-safety-auditing', 'parser-differential-auditing', 'patch-diff-analysis',
  'race-condition-auditing', 'remediation', 'sandbox-boundary-analysis', 'source-code-auditing',
  'state-and-lifetime-auditing',
];
/** Arm C additions: the three playbooks and the framework overlay from planning_update.md. */
export const PLAYBOOK_SKILLS = ['web-route-input-inventory', 'web-object-authorization', 'web-output-context'];
export const OVERLAY_SKILLS = ['fastapi-security-parity'];
export const PLAYBOOK_SET = [...PLAYBOOK_SKILLS, ...OVERLAY_SKILLS];

export const ARM_IDS = ['A', 'B', 'C'];
export const ARM_DEFINITIONS = {
  A: {
    id: 'A',
    label: 'baseline-4321f2b',
    description: `baseline runtime at revision ${BASELINE_REVISION} with the original 17 skills (no catalog, no skill/capability/evidence APIs)`,
    revision: BASELINE_REVISION,
  },
  B: {
    id: 'B',
    label: 'improved-runtime-17-skills',
    description: 'improved runtime (skill/capability/evidence APIs) with the same original 17 skills',
    revision: 'working-tree',
  },
  C: {
    id: 'C',
    label: 'improved-runtime-plus-playbooks',
    description: 'improved runtime plus the three web playbooks and the FastAPI parity overlay',
    revision: 'working-tree',
  },
};

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isTruthPath(relativePath) {
  const parts = relativePath.split('/');
  return parts.includes('expected') || parts.some(part => part.toLowerCase().includes('truth'));
}

/** Recursively hash a tree; excludes evaluator truth, VCS metadata and Python caches. */
export async function hashTree(root, { exclude = [] } = {}) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split('\\').join('/');
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === '__pycache__') continue;
        if (isTruthPath(rel)) continue;
        if (exclude.some(pattern => rel === pattern || rel.startsWith(`${pattern}/`))) continue;
        await walk(absolute);
      } else if (entry.isFile()) {
        if (isTruthPath(rel)) continue;
        if (exclude.some(pattern => rel === pattern || rel.startsWith(`${pattern}/`))) continue;
        if (entry.name.endsWith('.pyc')) continue;
        const content = await readFile(absolute);
        files.push({ path: rel, sha256: sha256(content), bytes: content.length });
      }
    }
  }
  await walk(root);
  const manifest = files.map(entry => `${entry.sha256}  ${entry.path}`).join('\n');
  return { root, hash: sha256(manifest), files };
}

/** Read and validate one fixture pair. Truth lives under expected/, never inside a source variant. */
export async function loadFixture(fixtureDir) {
  const truthPath = join(fixtureDir, 'expected', 'truth.json');
  const truth = JSON.parse(await readFile(truthPath, 'utf8'));
  validateTruth(truth, fixtureDir);
  const variants = {};
  for (const variant of ['vulnerable', 'fixed']) {
    const source = join(fixtureDir, variant);
    if (!existsSync(source)) throw new Error(`${fixtureDir}: missing ${variant} source directory`);
    variants[variant] = await hashTree(source);
    if (variants[variant].files.length === 0) throw new Error(`${fixtureDir}: ${variant} source is empty`);
    for (const file of variants[variant].files) {
      if (isTruthPath(file.path)) throw new Error(`${fixtureDir}: evaluator truth leaked into ${variant}/${file.path}`);
    }
  }
  return {
    name: truth.fixture,
    dir: fixtureDir,
    title: truth.title,
    objective: truth.objective,
    truthPath,
    truthSha256: sha256(await readFile(truthPath)),
    truth,
    variants,
  };
}

/** Structural validation only: the truth is evaluator data, not a proof of anything. */
export function validateTruth(truth, fixtureDir = '(fixture)') {
  const fail = message => { throw new Error(`${fixtureDir}: ${message}`); };
  if (truth?.schema !== TRUTH_SCHEMA) fail(`truth schema must be ${TRUTH_SCHEMA}`);
  if (typeof truth.fixture !== 'string' || !truth.fixture) fail('truth.fixture missing');
  if (typeof truth.objective !== 'string' || truth.objective.length < 40) fail('truth.objective missing or too short');
  if (truth.evaluator_only !== true) fail('truth must be marked evaluator_only');
  assertNeutralObjective(truth.objective, truth, fixtureDir);
  const variants = truth.variants;
  if (!variants || typeof variants !== 'object') fail('truth.variants missing');
  for (const variant of ['vulnerable', 'fixed']) {
    const entry = variants[variant];
    if (!entry) fail(`truth.variants.${variant} missing`);
    for (const key of ['expected_findings', 'expected_clean', 'required_gaps', 'forbidden_claims']) {
      if (!Array.isArray(entry[key])) fail(`truth.variants.${variant}.${key} must be an array`);
    }
    const ids = new Set();
    for (const item of [...entry.expected_findings, ...entry.expected_clean, ...entry.required_gaps, ...entry.forbidden_claims]) {
      if (typeof item.id !== 'string' || !item.id) fail(`variants.${variant}: item without id`);
      if (ids.has(item.id)) fail(`variants.${variant}: duplicate id ${item.id}`);
      ids.add(item.id);
      if (!Array.isArray(item.match_groups) || item.match_groups.length === 0) fail(`variants.${variant}.${item.id}: match_groups missing`);
      for (const group of item.match_groups) {
        if (!Array.isArray(group) || group.length === 0 || group.some(term => typeof term !== 'string' || !term)) {
          fail(`variants.${variant}.${item.id}: invalid match group`);
        }
      }
    }
    for (const finding of entry.expected_findings) {
      if (!['source_trace', 'offline_reproduction', 'live_reproduction', 'browser_execution'].includes(finding.supported_proof)) {
        fail(`variants.${variant}.${finding.id}: invalid supported_proof`);
      }
    }
  }
  for (const variant of ['vulnerable', 'fixed']) {
    const probe = truth.probe;
    if (probe && probe.expected_exit && probe.expected_exit[variant] === undefined) fail(`truth.probe.expected_exit.${variant} missing`);
  }
  return truth;
}

/** Mechanism words that would steer an agent toward a specific finding; keep objectives neutral. */
const OBJECTIVE_MECHANISM_TERMS = ['idor', 'xss', 'cross-site scripting', 'exploit', 'payload', 'bypass', 'unescaped', 'unencoded', 'parse-only', 'catch-all'];

/** Distinctive solution markers extracted from evaluator truth: ids, identifiers, paths, hyphenates. */
export function solutionMarkers(truth) {
  const markers = new Set();
  const addTerm = term => {
    const value = String(term ?? '').toLowerCase().trim();
    if (!value) return;
    if (/[a-z0-9]_[a-z0-9]/i.test(value) || value.includes('/') || /^[a-z][a-z0-9]*[A-Z]/.test(value) || (value.includes('-') && value.length >= 8)) {
      markers.add(value);
    }
  };
  for (const variant of Object.values(truth?.variants ?? {})) {
    for (const finding of variant.expected_findings ?? []) {
      if (finding.id) markers.add(String(finding.id).toLowerCase());
      for (const group of finding.match_groups ?? []) for (const term of group) addTerm(term);
    }
  }
  return [...markers];
}

/** Problems that make an objective leak evaluator knowledge or coach a specific answer. */
export function objectiveProblems(objective, truth) {
  const problems = [];
  const text = String(objective ?? '').toLowerCase();
  if (text.length < 40) problems.push('objective is shorter than 40 characters');
  if (text.length > 700) problems.push('objective exceeds 700 characters');
  if (text.split('\n').length > 4) problems.push('objective has more than four lines');
  for (const marker of solutionMarkers(truth)) if (text.includes(marker)) problems.push(`objective leaks solution marker "${marker}"`);
  for (const term of OBJECTIVE_MECHANISM_TERMS) if (text.includes(term)) problems.push(`objective contains mechanism term "${term}"`);
  return problems;
}

export function assertNeutralObjective(objective, truth, fixtureDir = '(fixture)') {
  const problems = objectiveProblems(objective, truth);
  if (problems.length) throw new Error(`${fixtureDir}: ${problems.join('; ')}`);
  return objective;
}

export async function discoverFixtures(repoRoot) {
  const root = join(repoRoot, 'bench', 'fixtures');
  const entries = await readdir(root, { withFileTypes: true });
  const fixtures = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, 'expected', 'truth.json'))) continue;
    fixtures.push(await loadFixture(dir));
  }
  fixtures.sort((a, b) => a.name.localeCompare(b.name));
  if (fixtures.length === 0) throw new Error(`no fixtures with expected/truth.json under ${root}`);
  return fixtures;
}

/** Mirror of extensions/p2o/src packageRoot(): resolve the package that owns an extension file. */
export function packageRootFor(extensionPath) {
  const directory = dirname(extensionPath);
  return resolve(directory, directory.endsWith('/dist/extensions/p2o') ? '../../..' : '../..');
}

function extensionCandidates(packageRoot) {
  return [
    join(packageRoot, 'extensions', 'p2o', 'index.ts'),
    join(packageRoot, 'dist', 'extensions', 'p2o', 'index.js'),
  ];
}

export function resolveExtensionPath(value) {
  const absolute = resolve(value);
  if (/\.(ts|js|mjs)$/.test(absolute)) {
    if (!existsSync(absolute)) throw new Error(`extension file not found: ${absolute}`);
    return absolute;
  }
  const found = extensionCandidates(absolute).find(candidate => existsSync(candidate));
  if (!found) throw new Error(`no extensions/p2o/index.ts or dist/extensions/p2o/index.js under ${absolute}`);
  return found;
}

async function skillNames(root) {
  const skillsRoot = join(root, 'skills');
  if (!existsSync(skillsRoot)) throw new Error(`arm package has no skills directory: ${root}`);
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
    .map(entry => entry.name).sort();
}

/** Normalize legacy (array) and new (dictionary) catalog document schemas to one shape. */
export function catalogDocuments(catalog) {
  const raw = catalog?.documents ?? [];
  const entries = Array.isArray(raw)
    ? raw.map(entry => (typeof entry === 'string' ? { id: entry } : entry))
    : Object.entries(raw).map(([id, value]) => (typeof value === 'string' ? { id, path: value } : { id, ...(value ?? {}) }));
  return entries.filter(entry => entry && typeof entry.id === 'string')
    .map(entry => ({ id: entry.id, path: entry.path ?? entry.file ?? entry.document, ...(entry.section ? { section: entry.section } : {}) }));
}

/** Shared library documents kept in every arm: handoffs/scope and the evidence ledger sections. */
export function isSharedDocument(id) {
  return typeof id === 'string' && (id.startsWith('shared:') || id.startsWith('evidence:'));
}

/** Copy only the original 17 skill documents plus shared package documents into an arm package. */
async function prepareFilteredSkills(repoRoot, target, keptNames) {
  const catalog = JSON.parse(await readFile(join(repoRoot, 'skills', 'catalog.json'), 'utf8'));
  if (catalog.version !== 1) throw new Error('skills/catalog.json version unsupported for arm preparation');
  const kept = new Set(keptNames);
  const skills = (catalog.skills ?? []).filter(skill => kept.has(skill?.name));
  if (skills.length !== keptNames.length) {
    const found = new Set(skills.map(skill => skill.name));
    throw new Error(`catalog is missing original skills: ${keptNames.filter(name => !found.has(name)).join(', ')}`);
  }
  const allDocuments = catalogDocuments(catalog);
  // Retain every document owned by a kept skill by id prefix or by path, plus shared/evidence
  // documents. This keeps references, recipes, rulesets and evidence sections regardless of the
  // schema generation that produced their ids.
  const documents = allDocuments.filter(document => {
    if (!document.path) return false;
    if (isSharedDocument(document.id)) return true;
    if (keptNames.some(name => document.id === name || document.id.startsWith(`${name}:`))) return true;
    return keptNames.some(name => document.path.startsWith(`skills/${name}/`));
  });
  await mkdir(join(target, 'skills'), { recursive: true });
  for (const name of keptNames) {
    await cp(join(repoRoot, 'skills', name), join(target, 'skills', name), { recursive: true });
  }
  const copied = new Set();
  for (const document of documents) {
    if (document.path.startsWith('skills/')) continue; // already copied with its skill directory
    if (copied.has(document.path)) continue;
    const source = join(repoRoot, document.path);
    if (!existsSync(source)) throw new Error(`kept catalog document missing on disk: ${document.path}`);
    const destination = join(target, document.path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
    copied.add(document.path);
  }
  // Defensive: a kept skill may declare extra documents through a skill.json dictionary (reference,
  // recipe or evidence lists). Copy any referenced package file that is still missing.
  for (const name of keptNames) {
    const sidecar = join(repoRoot, 'skills', name, 'skill.json');
    if (!existsSync(sidecar)) continue;
    let parsed;
    try { parsed = JSON.parse(await readFile(sidecar, 'utf8')); } catch { continue; }
    for (const value of referencedPaths(parsed)) {
      const relative = resolve(join('skills', name), value).split('\\').join('/');
      if (relative.startsWith('..') || relative.startsWith('/') || relative.startsWith('skills/')) continue;
      const source = join(repoRoot, relative);
      const destination = join(target, relative);
      if (existsSync(source) && !existsSync(destination)) {
        await mkdir(dirname(destination), { recursive: true });
        await cp(source, destination);
      }
    }
  }
  const filtered = { version: 1, skills, documents };
  await writeFile(join(target, 'skills', 'catalog.json'), `${JSON.stringify(filtered, null, 2)}\n`);
  return { skills: skills.length, documents: documents.length };
}

/** Collect path-like strings from arbitrary sidecar dictionaries without assuming one schema. */
function referencedPaths(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return [];
  const paths = [];
  for (const entry of Object.values(value)) {
    if (typeof entry === 'string') { if (/\.(md|ya?ml|json)$/.test(entry) && !/^https?:/.test(entry)) paths.push(entry); }
    else if (Array.isArray(entry)) for (const item of entry) if (typeof item === 'string' && /\.(md|ya?ml|json)$/.test(item) && !/^https?:/.test(item)) paths.push(item);
    else if (entry && typeof entry === 'object') paths.push(...referencedPaths(entry, depth + 1));
  }
  return paths;
}

/**
 * Resolve the three arms. Arm A needs a prepared baseline checkout; arm B gets an isolated
 * filtered package under workDir; arm C is the live working tree. Explicit package/extension
 * paths always win over the automatic resolution so a reviewer can pin any build.
 */
export async function resolveArms(repoRoot, { workDir, baselineDir, armPaths = {}, prepare = true, only } = {}) {
  const arms = {};
  const wanted = only ? new Set(only) : null;
  const want = id => armPaths[id];
  // A: baseline revision 4321f2b.
  if (!wanted || wanted.has('A')) {
    const explicit = want('A');
    const resolvedBaseline = baselineDir ?? join(repoRoot, 'bench', '.arms', `baseline-${BASELINE_REVISION}`);
    if (!explicit && !existsSync(join(resolvedBaseline, 'extensions', 'p2o', 'index.ts'))) {
      throw new Error(`arm A baseline is not prepared; run: node scripts/benchmark-skills.mjs prepare --revision ${BASELINE_REVISION}`);
    }
    const extensionPath = explicit ? resolveExtensionPath(explicit) : resolveExtensionPath(resolvedBaseline);
    const packageRoot = packageRootFor(extensionPath);
    const skills = await skillNames(packageRoot);
    if (!explicit) {
      if (skills.length !== ORIGINAL_SKILLS.length) {
        throw new Error(`arm A baseline must have exactly ${ORIGINAL_SKILLS.length} skills, found ${skills.length} in ${packageRoot}; run: node scripts/benchmark-skills.mjs prepare --revision ${BASELINE_REVISION}`);
      }
      const leaked = PLAYBOOK_SET.filter(name => skills.includes(name));
      if (leaked.length) throw new Error(`arm A baseline unexpectedly contains playbook skills: ${leaked.join(', ')}`);
    }
    arms.A = await describeArm('A', extensionPath, { skills, explicit: Boolean(explicit) });
  }
  // B: improved runtime, original 17 skills only.
  if (!wanted || wanted.has('B')) {
    const explicit = want('B');
    let extensionPath;
    if (explicit) extensionPath = resolveExtensionPath(explicit);
    else {
      const packageRoot = join(workDir, 'arm-b');
      const marker = join(packageRoot, '.prepared.json');
      const sourceHash = (await hashTree(join(repoRoot, 'src'))).hash + (await hashTree(join(repoRoot, 'extensions'))).hash;
      let reused = false;
      if (existsSync(marker)) {
        try { reused = JSON.parse(await readFile(marker, 'utf8')).sourceHash === sourceHash; } catch { reused = false; }
      }
      if (!reused) {
        if (!prepare) throw new Error('arm B package is not prepared and prepare=false');
        await rm(packageRoot, { recursive: true, force: true });
        await mkdir(packageRoot, { recursive: true });
        await cp(join(repoRoot, 'src'), join(packageRoot, 'src'), { recursive: true });
        await cp(join(repoRoot, 'extensions'), join(packageRoot, 'extensions'), { recursive: true });
        await prepareFilteredSkills(repoRoot, packageRoot, ORIGINAL_SKILLS);
        await writeFile(marker, `${JSON.stringify({ sourceHash, skills: ORIGINAL_SKILLS }, null, 2)}\n`);
      }
      extensionPath = resolveExtensionPath(packageRoot);
    }
    const packageRoot = packageRootFor(extensionPath);
    arms.B = await describeArm('B', extensionPath, { skills: await skillNames(packageRoot), explicit: Boolean(explicit) });
  }
  // C: improved runtime plus the new playbooks/overlay.
  if (!wanted || wanted.has('C')) {
    const explicit = want('C');
    const extensionPath = resolveExtensionPath(explicit ?? repoRoot);
    const packageRoot = packageRootFor(extensionPath);
    if (!explicit) {
      const skills = await skillNames(packageRoot);
      const missing = PLAYBOOK_SET.filter(name => !skills.includes(name));
      if (missing.length) throw new Error(`arm C is missing playbook skills: ${missing.join(', ')}`);
    }
    arms.C = await describeArm('C', extensionPath, { skills: await skillNames(packageRoot), explicit: Boolean(explicit) });
  }
  return arms;
}

/** Start flags the runner may pass; each is only used when the resolved package supports it. */
export const START_FLAGS = ['--export'];

/** True when the package text mentions the flag (extension, dev source or built bundle). */
export function supportsStartFlag(packageRoot, extensionPath, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidates = [extensionPath, join(packageRoot, 'src', 'target.ts'), join(packageRoot, 'dist', 'src', 'target.js')];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try { if (new RegExp(`${escaped}\\b`).test(readFileSync(candidate, 'utf8'))) return true; } catch { /* unreadable candidate is not evidence of support */ }
  }
  return false;
}

async function describeArm(id, extensionPath, { skills, explicit }) {
  const packageRoot = packageRootFor(extensionPath);
  const definition = ARM_DEFINITIONS[id];
  const src = await hashTree(join(packageRoot, 'src')).catch(() => ({ hash: null, files: [] }));
  const extensions = await hashTree(join(packageRoot, 'extensions')).catch(() => ({ hash: null, files: [] }));
  const skillsTree = await hashTree(join(packageRoot, 'skills')).catch(() => ({ hash: null, files: [] }));
  const extensionSha256 = sha256(await readFile(extensionPath));
  // The baseline revision predates the durable-export start flag; never pass it to arm A.
  const startFlags = id === 'A' ? [] : START_FLAGS.filter(flag => supportsStartFlag(packageRoot, extensionPath, flag));
  return {
    id, label: definition.label, description: definition.description, revision: definition.revision,
    extensionPath, packageRoot, explicit: Boolean(explicit), skills,
    playbooks: PLAYBOOK_SET.filter(name => skills.includes(name)),
    startFlags,
    hasCatalog: existsSync(join(packageRoot, 'skills', 'catalog.json')),
    hashes: { extensionSha256, packageHash: sha256(`${src.hash}:${extensions.hash}:${skillsTree.hash}`), src: src.hash, extensions: extensions.hash, skills: skillsTree.hash },
  };
}

/** Deterministic PRNG so a recorded seed reproduces the exact arm order. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(values, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

export function parseSeed(value) {
  if (value === undefined || value === '') return { seed: DEFAULT_SEED, random: false };
  if (value === 'random') return { seed: Math.floor(Math.random() * 2 ** 31), random: true };
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31 - 1) throw new Error('--seed must be an integer between 0 and 2147483647, or "random"');
  return { seed, random: false };
}

/**
 * Build the randomized plan: arms x fixtures x variants x repetitions, shuffled once with the
 * recorded seed. All budgets are fixed up front and copied into every run spec.
 */
export async function buildPlan({
  repoRoot, workDir, fixtures, arms, variants = ['vulnerable', 'fixed'], reps = DEFAULT_REPS,
  seed = DEFAULT_SEED, model = DEFAULT_MODEL, thinking = DEFAULT_THINKING,
  maxMinutes = DEFAULT_MAX_MINUTES, maxCostUsd = DEFAULT_MAX_COST_USD,
  maxTurns = DEFAULT_MAX_TURNS, maxTargetCommands = DEFAULT_MAX_TARGET_COMMANDS,
  delegation = false, workers = 1,
  baselineDir, armPaths = {},
} = {}) {
  if (!Number.isInteger(reps) || reps < 1 || reps > 20) throw new Error('reps must be an integer between 1 and 20');
  if (!fixtures?.length) throw new Error('at least one fixture is required');
  if (!arms?.length) throw new Error('at least one arm is required');
  const unknownArms = arms.filter(id => !ARM_IDS.includes(id));
  if (unknownArms.length) throw new Error(`unknown arm(s): ${unknownArms.join(', ')}`);
  const unknownVariants = variants.filter(variant => !['vulnerable', 'fixed'].includes(variant));
  if (unknownVariants.length) throw new Error(`unknown variant(s): ${unknownVariants.join(', ')}`);
  const budgets = { maxMinutes, maxCostUsd, maxTurns, maxTargetCommands, delegation, workers, extensionDeadlineMinutes: 30 };
  if (!Number.isFinite(maxMinutes) || maxMinutes < 1) throw new Error('maxMinutes must be >= 1');
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error('maxCostUsd must be > 0');
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 500) throw new Error('maxTurns must be an integer between 1 and 500');
  if (!Number.isInteger(maxTargetCommands) || maxTargetCommands < 1 || maxTargetCommands > 600) throw new Error('maxTargetCommands must be an integer between 1 and 600');
  const random = mulberry32(seed);
  const candidates = [];
  for (const arm of arms) {
    for (const fixture of fixtures) {
      for (const variant of variants) {
        for (let rep = 1; rep <= reps; rep += 1) {
          candidates.push({ arm, fixture: fixture.name, variant, rep });
        }
      }
    }
  }
  const ordered = shuffle(candidates, random);
  const fixtureIndex = new Map(fixtures.map(fixture => [fixture.name, fixture]));
  const runs = ordered.map((entry, index) => ({
    orderIndex: index,
    runId: `${entry.arm}-${entry.fixture}-${entry.variant}-r${entry.rep}`,
    arm: entry.arm,
    fixture: entry.fixture,
    variant: entry.variant,
    rep: entry.rep,
    objective: fixtureIndex.get(entry.fixture).objective,
    sourceDir: join(fixtureIndex.get(entry.fixture).dir, entry.variant),
    truthPath: fixtureIndex.get(entry.fixture).truthPath,
    truthSha256: fixtureIndex.get(entry.fixture).truthSha256,
  }));
  const armDefinitions = await resolveArms(repoRoot, { workDir, baselineDir, armPaths, only: arms });
  const selected = Object.fromEntries(arms.map(id => [id, armDefinitions[id]]));
  return {
    schema: PLAN_SCHEMA,
    repoRoot,
    workDir,
    createdAt: new Date().toISOString(),
    seed,
    model,
    thinking,
    budgets,
    reps,
    variants,
    armIds: [...arms],
    arms: selected,
    fixtures: fixtures.map(fixture => ({
      name: fixture.name, title: fixture.title, dir: fixture.dir, truthPath: fixture.truthPath,
      truthSha256: fixture.truthSha256, objective: fixture.objective,
      probe: fixture.truth.probe ?? null,
      variants: Object.fromEntries(Object.entries(fixture.variants).map(([variant, tree]) => [variant, { hash: tree.hash, files: tree.files.length }])),
    })),
    runCount: runs.length,
    runs,
  };
}

/** Copy one source variant into a run workspace; evaluator truth can never enter the copy. */
export async function copyVariant(sourceDir, destination) {
  const absoluteSource = resolve(sourceDir);
  const parent = dirname(absoluteSource);
  const parts = relative(parent, absoluteSource).split('/');
  if (parts.includes('expected') || parts.some(part => part.toLowerCase().includes('truth'))) {
    throw new Error(`refusing to copy evaluator truth into the agent workspace: ${sourceDir}`);
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(sourceDir, destination, {
    recursive: true,
    filter: source => {
      const rel = relative(sourceDir, source).split('\\').join('/');
      if (rel === '') return true;
      return !isTruthPath(rel) && !rel.split('/').includes('.git');
    },
  });
  const tree = await hashTree(destination);
  for (const file of tree.files) {
    if (isTruthPath(file.path)) throw new Error(`evaluator truth entered the agent workspace: ${file.path}`);
  }
  return tree;
}

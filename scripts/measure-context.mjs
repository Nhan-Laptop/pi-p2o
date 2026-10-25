// Measures what each role receives: prompt sizes, tool declarations per loadout and the skill pages a lead or worker reads.
// Read-only: no target, model, network or write outside a temporary directory; the extension is only registered against a stub Pi API.
//   node scripts/measure-context.mjs            from dist/ (run `npm run build` first)
//   node scripts/measure-context.mjs --source   straight from src/ through Pi's bundled jiti
//   add --json for machine output
// Sizes: prompts and skill pages in characters; declarations in bytes of JSON {name, description, parameters}. The brief is measured with a
// placeholder focus and task, so it is a lower bound. Lead facts match tests/minimal/recon.test.ts, so the numbers equal the recorded ceilings.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = process.argv.includes('--source'), asJson = process.argv.includes('--json');
async function load(relative) {
  if (!source) return import(new URL(`../dist/${relative}.js`, import.meta.url).href);
  const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  return require('jiti').createJiti(import.meta.url).import(new URL(`../${relative}.ts`, import.meta.url).href);
}
const { ownerInstructions, workerInstructions, workerBrief, reconInstructions } = await load('src/prompts');
const { ownerTools, workerTools } = await load('src/tool-policy');
const { ROLE_DEFAULTS, ROLES } = await load('src/roles');
const { SkillLibrary } = await load('src/skills');
const { registerP2O } = await load('extensions/p2o/index');

const named = text => [...new Set(text.match(/\bp2o_[a-z_]+\b/g) ?? [])];
const count = (text, needle) => text.split(needle).length - 1;
const result = { lead: {}, workers: [], declarations: {}, skills: {} };

// Lead prompt variants.
const facts = (kind, enabled, loopMode) => ({ runId: 'run-recon', targetLabel: kind === 'url' ? 'https://example.invalid' : '/target', targetKind: kind, sourceSkipped: 2, workerBudget: 20,
  delegation: enabled ? { enabled, maxWorkers: 3, maxDepth: 2 } : { enabled, maxWorkers: 1, maxDepth: 1 }, ...(loopMode ? { loopMode } : {}) });
for (const kind of ['directory', 'url']) for (const enabled of [false, true]) {
  const text = ownerInstructions(facts(kind, enabled)); result.lead[`${enabled ? 'delegated' : 'solo'} ${kind}`] = { chars: text.length, toolNames: named(text) };
}
const eventDriven = ownerInstructions(facts('url', true, 'event-driven')); result.lead['delegated url event-driven'] = { chars: eventDriven.length, toolNames: named(eventDriven) };

// Worker context per role and target kind.
for (const kind of ['directory', 'url']) for (const role of ROLES) {
  const ticket = { workerId: `p2o-${role}-abcdef`, role, runId: 'run-x', depth: 1, parentWorkerId: null, lifetime: 'until-stopped', target: { kind, label: kind === 'url' ? 'https://example.invalid' : '/target' } };
  const system = workerInstructions(ticket), brief = workerBrief({ ticket, focus: 'F', task: 'T' }), allowed = workerTools(role);
  result.workers.push({ role, kind, system: system.length, brief: brief.length, total: system.length + brief.length, reconBlocks: count(`${system}\n${brief}`, reconInstructions(kind)),
    toolNamesOutsideLoadout: named(`${system}\n${brief}`).filter(name => !allowed.includes(name)) });
}

// Tool declarations per loadout, from the real registration against a stub Pi API.
const dir = mkdtempSync(join(tmpdir(), 'p2o-measure-')), settingsPath = join(dir, 'settings.json');
try {
  writeFileSync(settingsPath, JSON.stringify({ p2o: {} }));
  const tools = new Map(), api = { registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerFlag() {}, getFlag() {}, on() {}, getActiveTools: () => [], setActiveTools() {}, sendUserMessage() {}, sendMessage() {}, appendEntry() {}, registerEntryRenderer() {} };
  registerP2O(api, { extensionPath: resolve(root, source ? 'extensions/p2o/index.ts' : 'dist/extensions/p2o/index.js'), settingsPath });
  const bytes = name => { const tool = tools.get(name); return Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })); };
  const loadouts = { owner: ownerTools(), worker: workerTools('discovery'), 'reporting worker': workerTools('reporting') };
  result.declarations = { registered: tools.size, total: [...tools.keys()].reduce((sum, name) => sum + bytes(name), 0), loadouts: Object.fromEntries(Object.entries(loadouts).map(([label, names]) => [label, { tools: names.length, bytes: names.reduce((sum, name) => sum + bytes(name), 0) }])),
    largest: [...tools.keys()].map(name => ({ name, bytes: bytes(name) })).sort((a, b) => b.bytes - a.bytes).slice(0, 5) };
} finally { rmSync(dir, { recursive: true, force: true }); }

// Skill pages a lead pages through and the first page a worker gets inlined for its role default.
const library = new SkillLibrary(root), pages = [];
for (let offset = 0, next = 0; next !== undefined; offset = next) { const page = await library.list(offset); pages.push(JSON.stringify(page).length); next = page.nextOffset; }
result.skills.listPages = pages; result.skills.listTotal = pages.reduce((sum, n) => sum + n, 0);
result.skills.roleDefaults = {};
for (const role of ROLES) for (const name of ROLE_DEFAULTS[role].skills) { const page = await library.read(name); result.skills.roleDefaults[role] = { skill: name, firstPage: page.text.length, total: page.totalCharacters }; }

if (asJson) console.log(JSON.stringify(result, null, 2));
else {
  const pad = (value, width) => String(value).padStart(width);
  console.log('Lead prompt (characters)'); for (const [label, item] of Object.entries(result.lead)) console.log(`  ${label.padEnd(30)} ${pad(item.chars, 6)}${item.toolNames.length ? `  NAMES TOOLS: ${item.toolNames.join(', ')}` : ''}`);
  console.log('\nWorker context (characters; brief is a lower bound)'); console.log('  kind       role         system  brief  total  recon-blocks  tool-names-outside-loadout');
  for (const w of result.workers) console.log(`  ${w.kind.padEnd(10)} ${w.role.padEnd(11)} ${pad(w.system, 6)} ${pad(w.brief, 6)} ${pad(w.total, 6)} ${pad(w.reconBlocks, 8)}      ${w.toolNamesOutsideLoadout.join(', ') || '-'}`);
  console.log(`\nTool declarations (bytes; ${result.declarations.registered} tools, ${result.declarations.total} B in total)`); for (const [label, item] of Object.entries(result.declarations.loadouts)) console.log(`  ${label.padEnd(18)} ${pad(item.tools, 2)} tools ${pad(item.bytes, 6)}`);
  console.log(`  largest: ${result.declarations.largest.map(item => `${item.name} ${item.bytes}`).join(', ')}`);
  console.log(`\nSkills (characters)\n  p2o_skill_list pages: ${result.skills.listPages.join(' + ')} = ${result.skills.listTotal}`); for (const [role, item] of Object.entries(result.skills.roleDefaults)) console.log(`  ${role.padEnd(11)} default skill ${item.skill}: first page ${item.firstPage} of ${item.total}`);
}

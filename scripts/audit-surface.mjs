// Read-only surface audit: what each role is actually given, and whether a tool's own text points at a tool that role
// cannot call. Registers the real extension against a stub Pi API (same pattern as scripts/measure-context.mjs); no run,
// no model, no network.
//   node scripts/audit-surface.mjs            human summary
//   node scripts/audit-surface.mjs --json     machine output (tests/minimal/surface-audit.test.ts)
// Sizes use the declaration-budget metric: description.length + JSON.stringify(parameters).length, names excluded.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const asJson = process.argv.includes('--json');
const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const jiti = require('jiti').createJiti(import.meta.url);
const load = relative => jiti.import(new URL(`../${relative}.ts`, import.meta.url).href);

const { registerP2O } = await load('extensions/p2o/index');
const policy = await load('src/tool-policy');
const { BOARD_VERB_NAMES } = await load('src/board-verbs');

const dir = mkdtempSync(join(tmpdir(), 'p2o-audit-'));
const settingsPath = join(dir, 'settings.json');
writeFileSync(settingsPath, JSON.stringify({ p2o: {} }));
const tools = new Map();
const api = {
  registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerFlag() {},
  getFlag() {}, on() {}, getActiveTools: () => [], setActiveTools() {}, sendUserMessage() {}, sendMessage() {},
  appendEntry() {}, registerEntryRenderer() {},
};
try {
  registerP2O(api, { extensionPath: resolve(root, 'extensions/p2o/index.ts'), settingsPath });
} finally { rmSync(dir, { recursive: true, force: true }); }

const chars = name => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} is declared in a role loadout but was not registered`);
  return String(tool.description ?? '').length + JSON.stringify(tool.parameters ?? {}).length;
};
const ROLES = {
  planner: policy.plannerTools(), worker: policy.workerTools(), validation: policy.workerTools('validation'),
  reporting: policy.workerTools('reporting'),
};
const roleTotals = Object.fromEntries(Object.entries(ROLES).map(([role, names]) => [role, {
  tools: names.length, chars: names.reduce((sum, name) => sum + chars(name), 0),
}]));
const modelTools = [...new Set([...policy.MODEL_TOOLS])];
const registered = [...tools.keys()];
const counts = {
  registered: tools.size,
  modelVisible: modelTools.filter(name => tools.has(name)).length,
  // S1/B10: registration and model visibility are the same surface now. Derive the difference instead of naming a hidden
  // set, so a future hidden verb shows up here without another constant to keep in sync.
  hidden: registered.filter(name => !modelTools.includes(name)).length,
  boardVerbs: BOARD_VERB_NAMES.length,
  planner: ROLES.planner.length,
};

/**
 * A tool's final description is its authoring text plus the boundary lines withBoundaries appends, so this scans exactly
 * what the model reads. A registered tool named in that text but absent from a holder role's loadout is a guaranteed
 * blocked call: the text is the role's own instruction, not third-party prose.
 */
const contradictions = [];
for (const [role, names] of Object.entries(ROLES)) {
  for (const name of names) {
    const text = String(tools.get(name)?.description ?? '');
    const mentioned = [...new Set(text.match(/\bp2o_[a-z_]+\b/g) ?? [])].filter(token => token !== name && tools.has(token));
    const missing = mentioned.filter(token => !names.includes(token));
    if (missing.length) contradictions.push({ role, tool: name, cannotCall: missing });
  }
}

const report = {
  counts, roleTotals, contradictions,
  tools: [...tools.keys()].map(name => ({ name, chars: chars(name), holders: Object.entries(ROLES).filter(([, names]) => names.includes(name)).map(([role]) => role) }))
    .sort((a, b) => b.chars - a.chars),
};

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Surface: ${counts.registered} registered, ${counts.modelVisible} model-visible, ${counts.hidden} hidden, ${counts.boardVerbs} board verbs`);
  console.log('Role loadouts:'); for (const [role, item] of Object.entries(roleTotals)) console.log(`  ${role.padEnd(10)} ${String(item.tools).padStart(2)} tools ${String(item.chars).padStart(6)} chars`);
  console.log(`Largest: ${report.tools.slice(0, 5).map(item => `${item.name} ${item.chars}`).join(', ')}`);
  console.log(report.contradictions.length ? `\nCROSS-REFERENCE CONTRADICTIONS: ${report.contradictions.length}` : '\nCross-reference contradictions: 0');
  for (const item of report.contradictions) console.log(`  ${item.role.padEnd(10)} holds ${item.tool.padEnd(20)} but its text names ${item.cannotCall.join(', ')}`);
}
if (report.contradictions.length) process.exitCode = 2;

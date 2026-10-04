#!/usr/bin/env node
/** Research-only pi-herdr dispatcher. It never reads exploit code or edits skills. */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = join(root, 'research/orange');
const model = 'openai-codex-account-3/gpt-6.1-sol:max';
const jitiPath = process.env.ORANGE_JITI_PATH || join(homedir(), '.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs');
const packageRoot = process.env.ORANGE_HERDR_PATH || join(homedir(), '.pi/agent/npm/node_modules/@yunosukeyoshino/pi-herdr');
const { createJiti } = await import(jitiPath);
const jiti = createJiti(import.meta.url);
const { herdSpawn } = await jiti.import(join(packageRoot, 'src/launch/herd-spawn.ts'));
const { createHerdrCli, herdrProcessRunner } = await jiti.import(join(packageRoot, 'src/herdr/adapter.ts'));
if (process.argv.includes('--check-runtime')) {
  if (typeof herdSpawn !== 'function') throw new Error('pi-herdr runtime unavailable');
  console.log('PASS: installed pi-herdr herdSpawn and CLI adapter imported; no agents started.');
  process.exit(0);
}
if (process.env.HERDR_ENV !== '1') throw new Error('Must run inside the current Herdr pane');
process.chdir(root);
const overview = JSON.parse(await readFile(join(base, 'overview-worker.json'), 'utf8'));
const entries = overview.pages.flatMap(p => p.entries.map(e => ({...e, index_page: p.source_url})));
if (entries.length !== overview.summary.archive_entry_count || new Set(entries.map(e => e.canonical_url)).size !== entries.length) throw new Error('Incomplete or duplicate archive inventory');
const inventory = {schema_version: 1, index_url: overview.source_url, retrieved_at: overview.retrieved_at,
  pagination: overview.pagination_completeness, entries: entries.map((e, i) => ({id: `O${String(i+1).padStart(3, '0')}`, title: e.title, url: e.canonical_url, date: e.date, year: e.year, index_page: e.index_page}))};
await mkdir(join(base, 'extractions'), {recursive: true});
await writeFile(join(base, 'inventory.json'), JSON.stringify(inventory, null, 2)+'\n');
let state;
try { state = JSON.parse(await readFile(join(base, 'delegations.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = {schema_version: 1, engine: 'pi-herdr installed herdSpawn API and Herdr CLI adapter', requested_model: model, overview_worker: 'worker-4b3ba52d', entries: []}; }
const now = () => new Date().toISOString();
let saveQueue = Promise.resolve();
function save() {
  saveQueue = saveQueue.then(async () => {
    const path = join(base, 'delegations.json');
    await writeFile(path+'.tmp', JSON.stringify(state, null, 2)+'\n');
    await rename(path+'.tmp', path);
  });
  return saveQueue;
}
async function cli(args) {
  const {stdout} = await exec('herdr', args, {maxBuffer: 4*1024*1024});
  return JSON.parse(stdout);
}
function packetValid(packet, entry) {
  return packet.schema_version === 1 && packet.source_id === entry.id && packet.url === entry.url &&
    ['included','context','excluded','duplicate','unavailable'].includes(packet.disposition) &&
    typeof packet.reason === 'string' && Array.isArray(packet.evidence) && Array.isArray(packet.candidate_additions);
}
async function packetFor(entry) {
  try {
    const p = JSON.parse(await readFile(join(base, `extractions/${entry.id}.json`), 'utf8'));
    return packetValid(p, entry) ? p : null;
  } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; }
}
const countArg = process.argv.find(a => a.startsWith('--concurrency='));
const concurrency = Math.max(1, Math.min(12, Number(countArg?.split('=')[1] || 6)));
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const entriesToRun = limitArg ? inventory.entries.slice(0, Number(limitArg.split('=')[1])) : inventory.entries;
const deps = {herdr: createHerdrCli(herdrProcessRunner()), roles: {worker: {name: 'worker'}}, parentModel: model};
let next = 0;
async function run(entry) {
  const existing = state.entries.find(e => e.source_id === entry.id);
  const packet = await packetFor(entry);
  if (existing?.status === 'completed' && packet) return;
  // A previous incomplete dispatch must be inspected/resumed, never duplicated silently.
  if (existing) {
    console.log(`${now()} HOLD ${entry.id}: prior ${existing.status}; inspect ${existing.agent_name}`);
    return;
  }
  const name = `worker-${entry.id.toLowerCase()}v001`;
  const task = `You own ONE Orange Tsai blog article: ${entry.id} — ${entry.title}\nURL: ${entry.url}\nRead research/orange/WORKER.md and follow its complete extraction contract. Write ONLY research/orange/extractions/${entry.id}.json. Read this actual article, filter/clean generic workflow, tool-purpose and derived handoff evidence; no copied solution, payload, exploit sequence, target testing or skill edits. Use your own named browser session orange-${entry.id} if needed. No other article is assigned to you. Verify exact method-only quotes and the JSON before finishing.`;
  const record = {source_id: entry.id, url: entry.url, agent_name: name, model, status: 'starting', started_at: now(), task};
  state.entries.push(record);
  await save();
  console.log(`${now()} START ${entry.id} ${name}`);
  try {
    const launched = await herdSpawn({role: 'worker', model, id: `${entry.id.toLowerCase()}v001`, task}, deps);
    if (launched.name !== name) throw new Error('Unexpected pi-herdr worker name');
    const info = (await cli(['agent','get',name])).result.agent;
    record.pane_id = info.pane_id;
    record.settled_status = info.agent_status;
    const result = await packetFor(entry);
    if (!result) throw new Error('Settled worker has no valid identity-matched extraction packet');
    record.status = 'completed';
    record.completed_at = now();
    record.disposition = result.disposition;
    record.output = `research/orange/extractions/${entry.id}.json`;
    // Transcript is a receipt only; avoid retaining visible source excerpts or unrelated runtime status.
    await save();
    // Close only our own, completed, ready worker, after its artifact is durable.
    if (['idle','done'].includes(info.agent_status)) {
      await cli(['pane','close',info.pane_id]);
      record.pane_closed_at = now();
    }
    await save();
    console.log(`${now()} DONE ${entry.id} ${name} ${result.disposition}`);
  } catch (error) {
    record.status = 'needs-review'; record.error = String(error.message || error); record.failed_at = now();
    try { const info = (await cli(['agent','get',name])).result.agent; record.pane_id = info.pane_id; record.settled_status = info.agent_status; }
    catch { /* No agent was recognized; preserve startup error. */ }
    await save();
    console.error(`${now()} NEEDS-REVIEW ${entry.id} ${name}: ${record.error}`);
  }
}
await Promise.all(Array.from({length: concurrency}, async () => {
  while (next < entriesToRun.length) await run(entriesToRun[next++]);
}));
await save();
const completed = state.entries.filter(e => e.status === 'completed').length;
console.log(`${now()} DISPATCH-END completed=${completed}/${inventory.entries.length}; remaining=${state.entries.filter(e=>e.status!=='completed').length}`);
if (process.argv.includes('--notify-parent') && process.env.HERDR_PANE_ID) {
  try {
    await cli(['agent','prompt',process.env.HERDR_PANE_ID, `Orange article dispatch finished: ${completed}/${inventory.entries.length} extraction workers completed. Read research/orange/delegations.json and the dispatch log. This is a research progress wake message, not goal completion; audit and integrate all results.`]);
  } catch (error) { console.error(`Parent wake message failed: ${error.message}`); }
}
process.exitCode = completed === inventory.entries.length ? 0 : 2;

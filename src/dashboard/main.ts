/**
 * planning_update.md P2/P3 (path "a"): the standalone dashboard entry.
 *
 *   node dist/src/dashboard/main.js snapshot --out <abs-new-dir> [--client <dir>] [--state-root ...]
 *   node dist/src/dashboard/main.js serve --snapshot <abs-dir> [--port <n>]
 *   node dist/src/dashboard/main.js serve [--state-root <dir>] [--report-root <dir>] [--port <n>] [--refresh <seconds>]
 *
 * `snapshot` writes the frozen directory (data tree, cited artifact bodies and copied static client); `serve --snapshot` opens
 * that frozen directory, while a bare `serve` reads the live roots. Both serve loopback only; the URL carries the per-launch
 * token in its fragment, so nothing printed to the terminal can end up in a request line. The build keeps the `src/` prefix
 * because `tsconfig.build.json` compiles `src` and `extensions` from the repo root.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validId } from '../validate.js';
import { buildDashboard, type DashboardSourceRoot } from './read-model.js';
import { serveDashboard } from './server.js';
import { writeDashboardSnapshot } from './snapshot.js';

const USAGE = [
  'usage:',
  '  node dist/src/dashboard/main.js snapshot --out <absolute-new-directory> [options]',
  '  node dist/src/dashboard/main.js serve --snapshot <absolute-directory> [--port <0-65535>]',
  '  node dist/src/dashboard/main.js serve [--state-root <dir>] [--report-root <dir>] [--port <n>] [--refresh <seconds>]',
  '',
  'snapshot writes a frozen, read-only dashboard (the data tree, cited artifact bodies and the built client assets) from committed state.',
  'serve --snapshot opens one frozen snapshot; a bare serve reads the live state/report roots. Both bind loopback (127.0.0.1),',
  'write nothing and expose no control. The printed URL carries the per-launch token in its fragment; keep it out of logs and commits.',
  '',
  'snapshot options:',
  '  --out <dir>            new absolute directory to write (required; never overwritten)',
  '  --client <dir>         built client assets to copy (default <cwd>/dashboard/out; build with npm run dashboard:build)',
  '  --state-root <dir>     state root to scan (repeatable; default <cwd>/.p2o-state)',
  '  --report-root <dir>    report root or one exported bundle to scan (repeatable; default <cwd>/.p2o-reports)',
  '  --run <runId>          keep only this run (repeatable)',
  '',
  'serve options:',
  '  --snapshot <dir>       serve one frozen snapshot written by snapshot (no live reads)',
  '  --state-root <dir>     live state root to scan (repeatable; default <cwd>/.p2o-state)',
  '  --report-root <dir>    live report root or one exported bundle to scan (repeatable; default <cwd>/.p2o-reports)',
  '  --port <n>             loopback port; 0 chooses a free port and prints it (default 0)',
  '  --refresh <seconds>    live rebuild interval (default 5)',
  '',
  '  -h, --help             show this help',
].join('\n');

export interface SnapshotArguments { out: string; client: string; stateRoots: DashboardSourceRoot[]; reportRoots: DashboardSourceRoot[]; runs: string[] }
export type ServeArguments =
  | { mode: 'snapshot'; snapshot: string; port: number }
  | { mode: 'live'; stateRoots: DashboardSourceRoot[]; reportRoots: DashboardSourceRoot[]; port: number; refreshMs: number };

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function parseSnapshotArguments(argv: readonly string[]): SnapshotArguments {
  const args = [...argv], command = args.shift();
  if (command !== 'snapshot') throw Error(`Expected the "snapshot" command, got ${command ?? '(none)'}`);
  let out: string | undefined, client: string | undefined;
  const stateRoots: DashboardSourceRoot[] = [], reportRoots: DashboardSourceRoot[] = [], runs: string[] = [];
  while (args.length) {
    const flag = args.shift()!, value = args.shift();
    if (value === undefined) throw Error(`Missing value for ${flag}`);
    if (flag === '--out') out = value;
    else if (flag === '--client') client = value;
    else if (flag === '--state-root') stateRoots.push({ path: value });
    else if (flag === '--report-root') reportRoots.push({ path: value });
    else if (flag === '--run') { if (!validId(value)) throw Error(`Invalid run id for --run: ${value}`); runs.push(value); }
    else throw Error(`Unknown option ${flag}`);
  }
  if (!out) throw Error('--out is required');
  const cwd = process.cwd();
  if (!stateRoots.length) stateRoots.push({ path: join(cwd, '.p2o-state'), optional: true });
  if (!reportRoots.length) reportRoots.push({ path: join(cwd, '.p2o-reports'), optional: true });
  return { out, client: resolve(client ?? join(cwd, 'dashboard', 'out')), stateRoots, reportRoots, runs };
}

export function parseServeArguments(argv: readonly string[]): ServeArguments {
  const args = [...argv], command = args.shift();
  if (command !== 'serve') throw Error(`Expected the "serve" command, got ${command ?? '(none)'}`);
  let snapshot: string | undefined, port: number | undefined, refreshSeconds: number | undefined;
  const stateRoots: DashboardSourceRoot[] = [], reportRoots: DashboardSourceRoot[] = [];
  while (args.length) {
    const flag = args.shift()!, value = args.shift();
    if (value === undefined) throw Error(`Missing value for ${flag}`);
    if (flag === '--snapshot') snapshot = value;
    else if (flag === '--port') {
      if (!/^\d{1,5}$/.test(value)) throw Error(`Invalid --port value ${value}; expected 0-65535`);
      port = Number(value);
      if (port > 65535) throw Error(`Invalid --port value ${value}; expected 0-65535`);
    } else if (flag === '--refresh') {
      if (!/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > 3600) throw Error(`Invalid --refresh value ${value}; expected 1-3600 seconds`);
      refreshSeconds = Number(value);
    } else if (flag === '--state-root') stateRoots.push({ path: resolve(value) });
    else if (flag === '--report-root') reportRoots.push({ path: resolve(value) });
    else throw Error(`Unknown option ${flag}`);
  }
  if (snapshot !== undefined) {
    if (stateRoots.length || reportRoots.length || refreshSeconds !== undefined) throw Error('--snapshot serves frozen data; it cannot be combined with --state-root, --report-root or --refresh');
    return { mode: 'snapshot', snapshot, port: port ?? 0 };
  }
  const cwd = process.cwd();
  if (!stateRoots.length) stateRoots.push({ path: join(cwd, '.p2o-state'), optional: true });
  if (!reportRoots.length) reportRoots.push({ path: join(cwd, '.p2o-reports'), optional: true });
  return { mode: 'live', stateRoots, reportRoots, port: port ?? 0, refreshMs: (refreshSeconds ?? 5) * 1000 };
}

async function snapshotCommand(argv: readonly string[]): Promise<number> {
  let args: SnapshotArguments;
  try { args = parseSnapshotArguments(argv); }
  catch (error) { console.error(`${messageOf(error)}\n\n${USAGE}`); return 2; }
  try {
    const build = await buildDashboard({ stateRoots: args.stateRoots, reportRoots: args.reportRoots, runs: args.runs, artifacts: true });
    const snapshot = await writeDashboardSnapshot(args.out, build, { clientRoot: args.client });
    const omissions = build.runs.reduce((sum, run) => sum + run.omitted.cases + run.omitted.findings + run.omitted.nodes + run.omitted.edges + run.omitted.anchors, build.index.omitted.findings);
    console.log(`dashboard snapshot: ${snapshot.directory}`);
    console.log(`runs: ${build.index.runs.length}, findings: ${build.index.totals.findings}, warnings: ${build.index.warnings.length}, omissions: ${omissions}, files: ${snapshot.files.length}, bytes: ${snapshot.bytes}`);
    if (snapshot.client) console.log(`client assets: ${snapshot.client.files} files copied from ${snapshot.client.root}`);
    console.log(`open it with: node dist/src/dashboard/main.js serve --snapshot ${snapshot.directory}`);
    return 0;
  } catch (error) { console.error(`dashboard snapshot failed: ${messageOf(error)}`); return 1; }
}

async function serveCommand(argv: readonly string[]): Promise<number> {
  let args: ServeArguments;
  try { args = parseServeArguments(argv); }
  catch (error) { console.error(`${messageOf(error)}\n\n${USAGE}`); return 2; }
  try {
    if (args.mode === 'snapshot') {
      const server = await serveDashboard({ mode: 'snapshot', directory: args.snapshot, port: args.port });
      console.log(server.url);
      console.log('mode: snapshot');
      return 0;
    }
    const server = await serveDashboard({ mode: 'live', stateRoots: args.stateRoots, reportRoots: args.reportRoots, port: args.port, refreshMs: args.refreshMs });
    // The URL is the only place the token is printed: it travels in the fragment, never in a request line or a log entry.
    console.log(server.url);
    console.log(`mode: live; state roots: ${args.stateRoots.map(root => root.path).join(', ')}; report roots: ${args.reportRoots.map(root => root.path).join(', ')}; refresh: ${args.refreshMs} ms`);
    return 0;
  } catch (error) { console.error(`dashboard serve failed: ${messageOf(error)}`); return 1; }
}

export async function main(argv: readonly string[]): Promise<number> {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(USAGE); return 0; }
  const command = argv[0];
  if (command === 'snapshot') return snapshotCommand(argv);
  if (command === 'serve') return serveCommand(argv);
  console.error(`Unknown command ${command}; the commands are snapshot and serve\n\n${USAGE}`);
  return 2;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) main(process.argv.slice(2)).catch(error => { console.error(messageOf(error)); process.exitCode = 1; });

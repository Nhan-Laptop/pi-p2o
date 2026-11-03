/**
 * planning_update.md P2 (path "a"): the standalone dashboard entry.
 *
 *   node dist/src/dashboard/main.js snapshot --out <abs-new-dir> [--client <dir>] [--state-root ...]
 *   node dist/src/dashboard/main.js serve --snapshot <abs-dir> [--port <n>]
 *
 * `snapshot` writes the frozen directory (data tree + copied static client); `serve` serves one snapshot on loopback. The
 * build keeps the `src/` prefix because `tsconfig.build.json` compiles `src` and `extensions` from the repo root. There is no
 * `map`/`serve` wrapper in Pi yet: the `/p2o map` command lands with P3, and P2 documents the standalone command only.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validId } from '../validate.js';
import { buildDashboard, type DashboardSourceRoot } from './read-model.js';
import { serveDashboardSnapshot } from './server.js';
import { writeDashboardSnapshot } from './snapshot.js';

const USAGE = [
  'usage:',
  '  node dist/src/dashboard/main.js snapshot --out <absolute-new-directory> [options]',
  '  node dist/src/dashboard/main.js serve --snapshot <absolute-directory> [--port <0-65535>]',
  '',
  'snapshot writes a frozen, read-only dashboard (the data tree plus the built client assets) from committed state.',
  'serve opens one snapshot on loopback (127.0.0.1); it reads the directory only, writes nothing and exposes no control.',
  '',
  'snapshot options:',
  '  --out <dir>            new absolute directory to write (required; never overwritten)',
  '  --client <dir>         built client assets to copy (default <cwd>/dashboard/out; build with npm run dashboard:build)',
  '  --state-root <dir>     state root to scan (repeatable; default <cwd>/.p2o-state)',
  '  --report-root <dir>    report root or one exported bundle to scan (repeatable; default <cwd>/.p2o-reports)',
  '  --run <runId>          keep only this run (repeatable)',
  '',
  'serve options:',
  '  --snapshot <dir>       snapshot directory written by snapshot (required)',
  '  --port <n>             loopback port; 0 chooses a free port and prints it (default 0)',
  '',
  '  -h, --help             show this help',
].join('\n');

export interface SnapshotArguments { out: string; client: string; stateRoots: DashboardSourceRoot[]; reportRoots: DashboardSourceRoot[]; runs: string[] }
export interface ServeArguments { snapshot: string; port: number }

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
  let snapshot: string | undefined, port: number | undefined;
  while (args.length) {
    const flag = args.shift()!, value = args.shift();
    if (value === undefined) throw Error(`Missing value for ${flag}`);
    if (flag === '--snapshot') snapshot = value;
    else if (flag === '--port') {
      if (!/^\d{1,5}$/.test(value)) throw Error(`Invalid --port value ${value}; expected 0-65535`);
      port = Number(value);
      if (port > 65535) throw Error(`Invalid --port value ${value}; expected 0-65535`);
    } else throw Error(`Unknown option ${flag}`);
  }
  if (!snapshot) throw Error('--snapshot is required');
  return { snapshot, port: port ?? 0 };
}

async function snapshotCommand(argv: readonly string[]): Promise<number> {
  let args: SnapshotArguments;
  try { args = parseSnapshotArguments(argv); }
  catch (error) { console.error(`${messageOf(error)}\n\n${USAGE}`); return 2; }
  try {
    const build = await buildDashboard({ stateRoots: args.stateRoots, reportRoots: args.reportRoots, runs: args.runs });
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
    const server = await serveDashboardSnapshot({ directory: args.snapshot, port: args.port });
    console.log(`dashboard server: ${server.url}`);
    console.log(`serving snapshot: ${server.directory}`);
    console.log('loopback only; static files and data, nothing written, no control route. ctrl-c to stop.');
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

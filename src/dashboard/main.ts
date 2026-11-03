/**
 * planning_update.md P1 (path "a"): the standalone dashboard entry, `node dist/src/dashboard/main.js snapshot --out <abs-new-dir>`
 * (the build keeps the `src/` prefix because `tsconfig.build.json` compiles `src` and `extensions` from the repo root).
 *
 * P1 ships the frozen data tree only. The loopback server and the Next.js client are P2/P3 and reuse `buildDashboard` /
 * `writeDashboardSnapshot` unchanged, so this file stays a thin argument parser plus one summary line.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validId } from '../validate.js';
import { buildDashboard, type DashboardSourceRoot } from './read-model.js';
import { writeDashboardSnapshot } from './snapshot.js';

const USAGE = [
  'usage: node dist/src/dashboard/main.js snapshot --out <absolute-new-directory> [options]',
  '',
  'Writes a frozen, read-only dashboard data tree (index.json + runs/<runId>.json) from committed state.',
  '',
  'options:',
  '  --out <dir>            new absolute directory to write (required; never overwritten)',
  '  --state-root <dir>     state root to scan (repeatable; default <cwd>/.p2o-state)',
  '  --report-root <dir>    report root or one exported bundle to scan (repeatable; default <cwd>/.p2o-reports)',
  '  --run <runId>          keep only this run (repeatable)',
  '  -h, --help             show this help',
].join('\n');

interface SnapshotArguments { out: string; stateRoots: DashboardSourceRoot[]; reportRoots: DashboardSourceRoot[]; runs: string[] }
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function parseSnapshotArguments(argv: readonly string[]): SnapshotArguments {
  const args = [...argv], command = args.shift();
  if (command !== 'snapshot') throw Error(`Unknown command ${command ?? '(none)'}; only "snapshot" exists in this phase`);
  let out: string | undefined;
  const stateRoots: DashboardSourceRoot[] = [], reportRoots: DashboardSourceRoot[] = [], runs: string[] = [];
  while (args.length) {
    const flag = args.shift()!, value = args.shift();
    if (value === undefined) throw Error(`Missing value for ${flag}`);
    if (flag === '--out') out = value;
    else if (flag === '--state-root') stateRoots.push({ path: value });
    else if (flag === '--report-root') reportRoots.push({ path: value });
    else if (flag === '--run') { if (!validId(value)) throw Error(`Invalid run id for --run: ${value}`); runs.push(value); }
    else throw Error(`Unknown option ${flag}`);
  }
  if (!out) throw Error('--out is required');
  const cwd = process.cwd();
  if (!stateRoots.length) stateRoots.push({ path: join(cwd, '.p2o-state'), optional: true });
  if (!reportRoots.length) reportRoots.push({ path: join(cwd, '.p2o-reports'), optional: true });
  return { out, stateRoots, reportRoots, runs };
}

export async function main(argv: readonly string[]): Promise<number> {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(USAGE); return 0; }
  let args: SnapshotArguments;
  try { args = parseSnapshotArguments(argv); }
  catch (error) { console.error(`${messageOf(error)}\n\n${USAGE}`); return 2; }
  try {
    const build = await buildDashboard({ stateRoots: args.stateRoots, reportRoots: args.reportRoots, runs: args.runs });
    const snapshot = await writeDashboardSnapshot(args.out, build);
    const omissions = build.runs.reduce((sum, run) => sum + run.omitted.cases + run.omitted.findings + run.omitted.nodes + run.omitted.edges + run.omitted.anchors, build.index.omitted.findings);
    console.log(`dashboard snapshot: ${snapshot.directory}`);
    console.log(`runs: ${build.index.runs.length}, findings: ${build.index.totals.findings}, warnings: ${build.index.warnings.length}, omissions: ${omissions}, files: ${snapshot.files.length}, bytes: ${snapshot.bytes}`);
    return 0;
  } catch (error) { console.error(`dashboard snapshot failed: ${messageOf(error)}`); return 1; }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) main(process.argv.slice(2)).catch(error => { console.error(messageOf(error)); process.exitCode = 1; });

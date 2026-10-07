#!/usr/bin/env node
// Opt-in installed-package integration using an explicitly selected immutable offline tool image.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PiRpc } from './benchmark-skills.mjs';
import { objectiveExtensionSource } from '../bench/lib/objective.mjs';
if (!process.argv.includes('--live')) throw new Error('--live required');
const get = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const image = get('--image', '');
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('--image needs the immutable local setup image ID');
const extension = resolve(get('--extension', `${process.env.HOME}/.pi/agent/git/github.com/Nhan-Laptop/pi-p2o/extensions/p2o/index.ts`));
const model = get('--model', 'deepseek/deepseek-flash');
const output = resolve(get('--output', 'tmp/skill-upgrade/installed-recipe'));
await mkdir(output, { recursive: true, mode: 0o700 });
const work = await mkdtemp(join(output, 'run-')); await mkdir(join(work, 'target'));
await writeFile(join(work, 'target', 'vulnerable.py'), 'import subprocess,pickle,yaml,requests\nsubprocess.run(user_value, shell=True)\npickle.loads(user_value)\nyaml.load(user_value)\neval(user_value)\nrequests.get(user_value)\n');
await writeFile(join(work, 'target', 'fixed.py'), 'import subprocess,json,yaml,requests\nsubprocess.run(["echo", user_value], shell=False)\njson.loads(user_value)\nyaml.safe_load(user_value)\nint(user_value)\nrequests.get(user_value,timeout=2)\n');
const objective = `This is an installed-extension integration of an OFFLINE STATIC scanner recipe on inert synthetic text, not exploitation. Never execute /target/*.py or install/download anything. Call p2o_capabilities with probe=semgrep; it must exercise local config. Read p2o_skill_read id=source-code-auditing:offline-python-semgrep and id=source-code-auditing:offline-python-semgrep-rules (follow pages if needed). Materialize those exact rules in /work/rules.yaml from approved document text. Do not use semgrep --validate: it downloads remote lint rules even with a local config; validate by the local positive/negative scan itself. Run the recipe with a local --config, no network, jobs1, max-memory256, timeout10, metrics off, disable-version-check and JSON output on /target. Read JSON and print a concise computed summary exactly VULNERABLE=<count for vulnerable.py> FIXED=<count for fixed.py> ERRORS=<count errors>. Print the sha256 of /work/rules.yaml so the operator can compare the catalog hash. Hits are static candidates only; do not report confirmed vulnerabilities. Record a note about results and untested dynamic reachability. Finish with p2o_finish and a concise summary. At most8 target commands, no workers. The synthetic expectations are five candidate matches in vulnerable.py and zero in fixed.py; do not manufacture a match to fit them.`;
const wrapper = join(work, 'objective.ts'); await writeFile(wrapper, objectiveExtensionSource(objective));
const child = spawn(get('--pi', `${process.env.HOME}/.pi/agent/bin/pi`), ['--no-extensions', '-e', extension, '-e', wrapper,
  '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-approve', '--no-session', '--mode', 'rpc',
  '--model', model, '--thinking', 'off', '--p2o-image', image], { cwd: work, stdio: ['pipe','pipe','pipe'] });
child.stdin.on('error', () => {});
const rpc = new PiRpc(child); rpc.answerDialogs();
let messages = [], exported, failed;
const started = Date.now();
try {
  await rpc.request('get_state'); await rpc.request('prompt', { message: '/p2o --target ./target --solo --export' });
  for (;;) {
    await delay(750); messages = (await rpc.request('get_messages')).data?.messages ?? [];
    const finish = messages.find(m => m.role === 'toolResult' && m.toolName === 'p2o_finish' && !m.isError);
    if (finish?.details?.exportPath && !(await rpc.request('get_state')).data?.isStreaming) {
      exported = JSON.parse(await readFile(finish.details.exportPath, 'utf8')); await cp(finish.details.exportPath, join(work, 'evidence.json')); break;
    }
    if (Date.now() - started > 5*60_000 || rpc.recordSummary.targetCommands > 12) throw new Error('Integration budget exceeded');
    if (rpc.recordSummary.providerErrors.length && !(await rpc.request('get_state')).data?.isStreaming) throw new Error('Terminal provider failure');
  }
  if (exported.manifest.image !== image) throw new Error('Wrong image binding');
  if (exported.manifest.capabilities.capabilities.find(c => c.id === 'tool.semgrep')?.availability !== 'supported') throw new Error('No successful runtime probe');
  const outputText = exported.records.filter(r => r.kind === 'evidence').map(r => r.data?.stdout ?? '').join('\n');
  if (!/VULNERABLE=5 FIXED=0 ERRORS=0/.test(outputText)) throw new Error('Actual candidate counts did not match fixture');
  const rulesHash = exported.manifest.skillHashes['source-code-auditing:offline-python-semgrep-rules'];
  if (!rulesHash || !outputText.includes(rulesHash)) throw new Error('Materialized rule content hash does not match catalog');
  await writeFile(join(work, 'summary.json'), JSON.stringify({ status: 'passed', model, extensionSha256: createHash('sha256').update(await readFile(extension)).digest('hex'), image, rulesHash,
    elapsedMs: Date.now()-started, outcome: { vulnerableCandidates: 5, fixedCandidates: 0, errors: 0 }, runtimeClaim: 'static candidate generation only' }, null, 2));
} catch (error) { failed = String(error); }
finally {
  await rpc.request('abort', {}, 10000).catch(() => {});
  await rpc.request('prompt', { message: '/p2o stop' }, 30000).catch(() => {}); await rpc.close();
  const runId = exported?.runId;
  const remaining = runId ? execFileSync('docker', ['ps','-a','--filter',`label=pi-p2o.run=${runId}`,'--format','{{.Names}}'], { encoding:'utf8' }).trim() : 'unverified';
  if (remaining) failed = `${failed ?? ''} Cleanup: ${remaining}`;
  await writeFile(join(work, 'messages.json'), JSON.stringify(messages), { mode: 0o600 });
  await writeFile(join(work, 'runtime.json'), JSON.stringify({ failed, stderr: rpc.stderr, events: rpc.records, cleanup: remaining }), { mode: 0o600 });
}
console.log(JSON.stringify({ work, status: failed ? 'failed' : 'passed', failed }, null, 2));
if (failed) process.exitCode = 1;

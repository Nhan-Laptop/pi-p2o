#!/usr/bin/env node
// Independent first-use qualification. Real installed Pi RPC UI + registerP2O/default composition.
// No backend, entry, runtime, filesystem, git, engine, UI context or model-registry doubles.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { startInertProvider, transcriptResults, UNTESTED_SCOPE } from './inert-provider.mjs';
import { PiRpc, GITHUB, GITHUB_COMMIT, CONSENT_LABEL, LIVE_CONSENT_LABEL, LIVE_SELECTION } from './rpc.mjs';
import { append, command, dockerCanary, hashTree, jsonArtifacts, observeDocker, observeProcesses,
  redact, sha256, sleep, walk } from './observe.mjs';

const repo = resolve(import.meta.dirname, '../..');
const flag = name => process.argv.includes(name);
const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const allowed = new Set(['--require-live', '--github', '--case', '--artifacts', '--pi', '--help', '--live', '--live-preflight']);
for (let index = 2; index < process.argv.length; index++) {
  if (!allowed.has(process.argv[index])) throw new Error(`UNKNOWN_HARNESS_FLAG: ${process.argv[index]}`);
  if (['--case', '--artifacts', '--pi'].includes(process.argv[index])) index++;
}
const livePreflight = flag('--live-preflight');
if (flag('--help')) {
  console.log('node tests/qualification-first-use/run.mjs [--github] [--case NAME] [--artifacts /tmp/NEW-DIR] [--pi /absolute/pi] [--require-live]\nCases: decline-onboarding, decline-plan, url, local, github, stop-stale-reuse (legacy alias: stop-resume)\n--github is an explicit HTTPS public fixed-commit opt-in. stop-stale-reuse is a NEGATIVE stale-reuse test: stop is terminal, resume must refuse RUN_TERMINAL with zero stale resources. --require-live is a NO-CALL readiness refusal, not permission to spend.');
  process.exit(0);
}
const root = option('--artifacts') ? resolve(option('--artifacts')) : mkdtempSync(join(tmpdir(), 'p2o-qualification-first-use-'));
// Reuse of an explicit artifacts root is intentional: the live ledger must survive across sequential live runs so
// the aggregate cap is enforced across the whole qualification, not per invocation.
if (option('--artifacts')) mkdirSync(root, { recursive: true, mode: 0o700 });
const commandsPath = join(root, 'commands.jsonl');
const binary = option('--pi') ?? command('/usr/bin/which', ['pi']).stdout.trim();
// The IMPLEMENTATION agent that invokes this harness, recorded from its own session environment. It is never
// inferred, never substituted for the assessment model, and never used for a provider call by this harness.
// Receipt-derived host/worker models stay separate: versions.*, case.hostState, worker config, planning
// receipts and worker session files each report what the installed host actually did.
const implementationSelection = {
  provider: process.env.PI_PROVIDER ?? 'unknown', model: process.env.PI_MODEL ?? 'unknown',
  thinking: process.env.PI_REASONING_LEVEL ?? 'unknown',
  source: 'PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL of the invoking implementation session',
};
const summary = { schemaVersion: 1, startedAt: new Date().toISOString(), artifacts: root,
  implementationSelection, assessmentSelection: { provider: 'inert-fixture', model: 'inert-worker', thinking: 'off' },
  evidenceClass: 'deterministic-inert-provider-mechanical-chain-NOT-live-AI', consent: CONSENT_LABEL,
  sourceControl: 'repository has no committed baseline; current-file hashes, not a Git commit claim',
  versions: {}, cases: [], blockers: [], live: { called: false,
    invokingImplementationSelection: implementationSelection,
    assessmentSelection: { ...LIVE_SELECTION },
    evidenceClass: 'live-real-provider-model-calls-not-independent-verification',
    authorized: { by: 'parent', aggregateUsd: 1, aggregateTokens: 400_000, perRunUsd: 0.32, perRunTokens: 130_000,
      attemptPolicy: 'one live run per target plus one bounded corrective retry total',
      scope: 'controlled loopback fixtures and the read-only pinned public octocat commit only' },
    executed: 0, spend: { usd: 0, tokens: 0 },
    blockers: ['Live mode is opt-in (`--live --case url|local|github`); the mechanical run never calls a provider.',
      'Parent-authorized bounded live DeepSeek/max qualification has not been executed yet: awaiting the explicit freeze signal; no paid call has been made by this harness.',
      'deepseek/deepseek-flash IS priced in the pinned catalog (0.3/1.2 USD per M) and the installed host resolves its credential; this is not an unpriced or unqualified path.',
      'Aggregate cap $1 / 400k tokens with one corrective retry total is enforced by the live ledger; exceeding it refuses further runs instead of substituting.'] } };
const save = (path, value) => writeFileSync(path, `${JSON.stringify(redact(value), null, 2)}\n`, { mode: 0o600 });
const sourceInventory = () => ['src', 'extensions', 'containers'].flatMap(tree => hashTree(join(repo, tree))
  .filter(row => !(tree === 'containers' && row.path.startsWith('build/')))
  .map(row => ({ ...row, path: `${tree}/${row.path}` })));
const initialSource = sourceInventory(); save(join(root, 'source-hashes-start.json'), initialSource);
for (const [name, file, args] of [['hostPi', binary, ['--version']], ['workerPi', join(repo, 'node_modules/.bin/pi'), ['--version']],
  ['node', process.execPath, ['--version']], ['git', '/usr/bin/git', ['--version']], ['docker', '/usr/bin/docker', ['version', '--format', '{{json .}}']]]) {
  const receipt = command(file, args, { log: commandsPath });
  summary.versions[name] = { ...receipt, binary: realpathSync(file), binarySha256: sha256(readFileSync(realpathSync(file))) };
}
function piPackage(file) {
  const executable = realpathSync(file);
  let folder = dirname(executable);
  for (let count = 0; count < 6; count++, folder = dirname(folder)) {
    const packagePath = join(folder, 'package.json');
    if (existsSync(packagePath)) {
      const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (metadata.name === '@earendil-works/pi-coding-agent') return { root: folder, metadata };
    }
    const current = join(folder, 'install/current-version');
    if (existsSync(current)) {
      const version = readFileSync(current, 'utf8').trim();
      check(/^[a-zA-Z0-9.+_-]+$/.test(version), 'host-binary-identity', 'invalid managed Pi version');
      const root = join(folder, 'install/releases', version, 'node_modules/@earendil-works/pi-coding-agent');
      return { root, metadata: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) };
    }
  }
  fail('host-binary-identity', `cannot locate actual Pi package for ${file}`);
}
for (const [label, file] of [['host', binary], ['repository', join(repo, 'node_modules/.bin/pi')]]) {
  const found = piPackage(file), cli = realpathSync(join(found.root, found.metadata.bin.pi));
  summary.versions[`${label}Sdk`] = found.metadata.version;
  summary.versions[`${label}Cli`] = { path: cli, sha256: sha256(readFileSync(cli)) };
}
summary.versions.explicitCompatibilityBoundary = `host Pi/SDK ${summary.versions.hostSdk} drives real repo worker Pi/SDK ${summary.versions.repositorySdk}; not an unnoticed version substitution`;
summary.versions.inertProvider = { scriptVersion: 1, name: 'deterministic-inert-provider',
  path: join(import.meta.dirname, 'inert-provider.mjs'), sha256: sha256(readFileSync(join(import.meta.dirname, 'inert-provider.mjs'))) };
if (existsSync(join(repo, 'dist'))) save(join(root, 'runtime-build-hashes.json'), hashTree(join(repo, 'dist')).filter(row => /runtime\//.test(row.path)));
const lock = JSON.parse(readFileSync(join(repo, 'containers/pack.lock.json'), 'utf8'));
summary.containerLock = { image: lock.image.pin, engineVersion: lock.engineVersion, packVersion: lock.packVersion,
  sha256: sha256(readFileSync(join(repo, 'containers/pack.lock.json'))) };

function fail(stage, message) { throw Object.assign(new Error(message), { stage }); }
function check(condition, stage, message) { if (!condition) fail(stage, message); }
function configs(home) { return jsonArtifacts(home).filter(row => row.path.endsWith('/control/application.json')); }
function workerFiles(home) { return walk(home).filter(path => path.endsWith('/worker.json')); }
function stageFor(rpc) { return rpc.prompts.at(-1)?.request.title ?? 'extension-host-startup'; }

async function runCase(name) {
  const folder = join(root, name); mkdirSync(folder, { mode: 0o700 });
  const home = join(folder, 'home'), agent = join(home, '.pi/agent'), cwd = join(folder, 'workspace');
  for (const path of [home, agent, cwd]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const result = { name, started: Date.now(), status: 'running', evidenceClass: summary.evidenceClass, home,
    noConfigurationPreseeded: walk(home).length === 0, commands: [], checks: {}, sideEffects: [] };
  summary.cases.push(result); let stage = 'fixture-setup';
  const kind = name === 'url' || name.startsWith('decline-') ? 'url' : name === 'github' ? 'github' : 'local';
  let target, targetServer, watcher, rpc, processes, docker, runId;
  const io = [], targetRequests = [];
  const source = join(folder, 'target-source');
  const marker = `CANARY_ONLY_IN_REAL_SOURCE_${crypto.randomUUID()}`;
  const content = `export const canary = "${marker}";\nexport function render(input) { return input; }\n`;
  let before;
  const provider = await startInertProvider({ holdPacket: name === 'stop-stale-reuse',
    onReceipt: receipt => append(join(folder, 'provider.jsonl'), receipt) });
  try {
    if (kind === 'url') {
      targetServer = createServer((request, response) => {
        const receipt = { at: Date.now(), method: request.method, path: request.url }; targetRequests.push(receipt);
        append(join(folder, 'target-requests.jsonl'), receipt);
        if (request.method !== 'GET' || request.url !== '/exact') { response.writeHead(403).end(); return; }
        response.writeHead(200, { 'content-type': 'text/plain', 'x-qualification': 'owned-loopback-target' }).end('Benign qualification fixture. No vulnerability claim.');
      });
      await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
      target = `http://127.0.0.1:${targetServer.address().port}/exact`;
    } else if (kind === 'github') target = GITHUB;
    else {
      // The harness-owned source directory IS the local target; it must be the canonical absolute path.
      target = source;
      mkdirSync(source, { mode: 0o700 });
      writeFileSync(join(source, 'index.ts'), content);
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'inert-untrusted-source', scripts: {
        postinstall: `node -e "require('fs').writeFileSync('${join(folder, 'SCRIPT_EXECUTED')}','bad')"` } }));
      before = hashTree(source); save(join(folder, 'source-before.json'), before);
      watcher = spawn('/usr/bin/python3', [join(import.meta.dirname, 'io-watch.py'), source], { stdio: ['ignore', 'pipe', 'pipe'] });
      let buffer = ''; watcher.stdout.on('data', data => {
        buffer += data.toString(); for (;;) { const index = buffer.indexOf('\n'); if (index < 0) break;
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try { const event = JSON.parse(line); io.push(event); append(join(folder, 'source-io.jsonl'), event); } catch { /* bounded monitor diagnostics */ }
        }
      });
      for (let count = 0; count < 100 && !io.some(row => row.event === 'ready'); count++) await sleep(20);
      check(io.some(row => row.event === 'ready'), 'source-observer', 'real inotify observer did not become ready');
    }
    result.target = target;
    const env = { HOME: home, USER: process.env.USER ?? 'qualification', LOGNAME: process.env.LOGNAME ?? 'qualification',
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', TERM: 'dumb', TMPDIR: folder,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'),
      PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      P2O_QUALIFICATION_INERT_ENDPOINT: provider.origin };
    // Explicit allowlist: ALL inherited P2O_CONFIG*, app/control modules, credentials/proxies/preloads are absent.
    result.environmentKeys = Object.keys(env).sort();
    const args = ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
      '--no-themes', '--no-context-files', '--no-tools', '--no-approve', '--extension', join(import.meta.dirname, 'extension.ts'),
      '--provider', 'inert-fixture', '--model', 'inert-worker', '--thinking', 'off'];
    rpc = new PiRpc({ binary, args, cwd, env, kind,
      decline: name === 'decline-onboarding' ? 'First-use owner consent' : name === 'decline-plan' ? 'Approve p2o run' : undefined,
      log: join(folder, 'rpc.jsonl'), stderrPath: join(folder, 'host.stderr'),
      beforeDialog: async request => {
        append(join(folder, 'approval-boundaries.jsonl'), { at: Date.now(), title: request.title,
          targetRequests: targetRequests.length, workerConfigs: workerFiles(home).length,
          workerIdentities: processes ? [...processes.observed.values()] : [],
          productionContainersObserved: docker?.containers.size ?? 0,
          sourceIO: io.filter(row => row.event === 'inotify').length,
          consentLabel: CONSENT_LABEL });
        if (request.title?.startsWith('Approve p2o') || request.title?.startsWith('Approve plan ')) {
          check(targetRequests.length === 0, 'pre-plan-approval-side-effects', 'target contacted before model-plan approval');
          check(workerFiles(home).length === 0, 'pre-plan-approval-side-effects', 'worker launched before model-plan approval');
          check(!io.some(row => row.event === 'inotify' && (row.mask & 0x21)), 'pre-plan-approval-source-io', 'source opened/read before model-plan approval');
        }
      } });
    processes = observeProcesses(home, rpc.child.pid, join(folder, 'processes.jsonl'));
    docker = observeDocker(home, lock.image.pin, join(folder, 'docker-events.jsonl'), commandsPath);
    stage = 'installed-extension-host';
    const state = await rpc.request('get_state', {}, 25000); result.hostState = state;
    check(state.success && state.data?.model?.provider === 'inert-fixture' && state.data?.model?.id === 'inert-worker', stage, 'installed host did not select exact inert fixture; never substitute');
    const commands = await rpc.request('get_commands'); result.registeredCommands = commands;
    check(commands.data?.commands?.filter(item => item.name === 'p2o').length === 1, stage, 'real p2o command registration is missing or duplicated');
    check(!commands.data?.commands?.some(item => item.name.startsWith('p2o_')), stage, 'legacy p2o_* slash commands unexpectedly registered');
    await rpc.request('set_auto_retry', { enabled: false }); await rpc.request('set_auto_compaction', { enabled: false });
    const invoke = async text => {
      result.commands.push({ at: Date.now(), text }); const receipt = await rpc.command(text);
      append(join(folder, 'command-receipts.jsonl'), { text, ...receipt });
      return receipt;
    };
    stage = 'first-use-owner-ui -> default-backend -> model-plan';
    const planned = await invoke(`/p2o --target ${JSON.stringify(target)}${name === 'url' ? ' --plan-only' : ''}`);
    result.initialOutcome = planned;
    if (name === 'decline-onboarding') {
      check(planned.error?.includes('CANCELLED'), 'declined-onboarding', 'onboarding did not fail closed on actual negative UI response');
      check(provider.receipts.length === 0 && targetRequests.length === 0 && workerFiles(home).length === 0 && configs(home).length === 0, 'declined-onboarding-side-effects', 'declined UI caused planning/target/worker/config side effects');
      check(!walk(home).some(path => path.includes('/.p2o/')), 'declined-onboarding-persistence', 'cancelled onboarding saved p2o configuration');
      result.checks.declinedNoSideEffects = true; result.status = 'passed'; return;
    }
    if (planned.error) fail(stageFor(rpc), planned.error);
    if (name === 'decline-plan') fail('declined-plan', 'model-plan decline was ignored');
    check(planned.outcome?.details?.runId, stageFor(rpc), 'no real sealed plan/run receipt in the host session');
    runId = planned.outcome.details.runId; result.runId = runId;
    if (name === 'url') {
      check(planned.outcome.details.planOnly === true && provider.receipts.length === 1 && targetRequests.length === 0 && workerFiles(home).length === 0 && docker.containers.size === 0,
        'plan-only-side-effects', 'plan-only touched target, worker or container, or did not use the actual provider completion');
      result.checks.planOnlyNoTargetOrWorkers = true;
      const approved = await invoke(`/p2o approve ${planned.outcome.details.planId}`); result.approvalOutcome = approved;
      if (approved.error) fail(stageFor(rpc), approved.error);
    }
    result.checks.actualModelPlanTransport = provider.receipts.some(receipt => receipt.step === 'plan');
    check(result.checks.actualModelPlanTransport, 'model-plan', 'no actual installed-host provider request');
    if (name === 'stop-stale-reuse') {
      stage = 'actual-worker-container-before-stop';
      for (let count = 0; count < 500 && !provider.held; count++) await sleep(100);
      check(provider.held, stage, `real worker did not reach held packet stage: ${provider.errors.join('; ')}`);
      const oldContext = provider.receipts.findLast(receipt => receipt.turn?.context)?.turn.context;
      result.oldAttempt = oldContext?.attemptId; result.oldObservedRuntime = oldContext?.observedRuntime;
      const stopped = await invoke(`/p2o stop ${runId}`); result.stopOutcome = stopped;
      if (stopped.error) fail('verified-stop', stopped.error);
      const stoppedResources = { at: Date.now(), workers: processes.survivors(), containers: docker.absence() };
      save(join(folder, 'resources-after-stop.json'), stoppedResources);
      check(stoppedResources.workers.length === 0 && stoppedResources.containers.every(row => row.absent), 'stop-resource-absence', 'owned resources remain after reported stop');
      const attemptsBefore = workerFiles(home).length, exchangesBefore = provider.receipts.length;
      provider.release();
      // NEGATIVE stale-reuse: stop is a terminal cancellation. Resume must refuse, never silently
      // re-admit a terminal run or reuse an old attempt identity. This is NOT a resumability claim.
      const resumed = await invoke(`/p2o resume ${runId}`); result.resumeOutcome = resumed;
      check(typeof resumed.error === 'string' && resumed.error.includes('RUN_TERMINAL'), 'stop-terminal-refusal',
        `resume of a stopped terminal run did not fail closed with RUN_TERMINAL: ${resumed.error ?? JSON.stringify(resumed.outcome?.content ?? '').slice(0, 240)}`);
      await sleep(500);
      const reused = provider.receipts.slice(exchangesBefore).find(receipt => receipt.turn?.context?.attemptId && receipt.turn.context.attemptId !== result.oldAttempt);
      check(!reused, 'stop-stale-reuse-no-redispatch', 'refused resume still dispatched a new model/worker exchange');
      check(workerFiles(home).length === attemptsBefore, 'stop-stale-reuse-no-new-attempt', 'refused resume created a new worker attempt');
      const staleResources = { at: Date.now(), workers: processes.survivors(), containers: docker.absence() };
      save(join(folder, 'resources-after-refused-resume.json'), staleResources);
      check(staleResources.workers.length === 0 && staleResources.containers.every(row => row.absent), 'stop-stale-reuse-resource-absence', 'refused resume left owned resources behind');
      const terminal = await invoke(`/p2o status ${runId}`); result.terminalStatus = terminal.outcome?.details?.result;
      check(['completed', 'failed', 'cancelled'].includes(result.terminalStatus?.run?.state), 'stop-terminal-state', `stopped run is not terminal: ${result.terminalStatus?.run?.state ?? 'unknown'}`);
      result.verification = { packetGate: 'packet held at stop, never admitted',
        findings: result.terminalStatus?.findings ?? [],
        independentReplay: 'NOT invoked: negative stale-reuse case; stop is terminal cancellation and the refused resume is fail-closed',
        label: 'NEGATIVE stale-reuse test — NOT successful resumability' };
      result.checks.stopTerminalRefusal = true; result.checks.resumeRefusedFailClosed = true;
      result.status = 'passed'; return;
    }
    stage = 'supervisor-completion';
    let status;
    for (let count = 0; count < 300; count++) {
      const read = await invoke(`/p2o status ${runId}`); if (read.error) fail(stage, read.error);
      status = read.outcome?.details?.result;
      if (['completed', 'failed', 'cancelled'].includes(status?.run?.state)) break;
      await sleep(150);
    }
    result.finalStatus = status;
    check(status?.run?.state === 'completed', stage, `observed run ${status?.run?.state ?? 'unknown'}; ${JSON.stringify(status?.failures ?? [])}`);
    // Current production status projection nests attempts under `process` (src/interface/presentation.ts);
    // `decision.status === 'accepted'` is the supervisor's own admission test, not a substring match.
    const attempts = status?.process?.attempts ?? [];
    const admitted = (status?.packets ?? []).filter(row => row.decision?.status === 'accepted');
    check(attempts.length > 0 && admitted.length > 0, 'packet-admission', `actual worker process did not yield an accepted packet (observed attempts ${attempts.length}, accepted packets ${admitted.length})`);
    check(admitted.every(row => attempts.some(attempt => attempt.attemptId === row.attemptId)), 'packet-attempt-binding', 'accepted packet is not bound to an observed attempt identity');
    check(attempts.every(attempt => attempt.observedRuntime?.attestation === 'attested' &&
      attempt.observedRuntime?.selection?.provider === 'inert-fixture' && attempt.observedRuntime?.selection?.model === 'inert-worker' &&
      attempt.observedRuntime?.selection?.thinking === 'off'), 'worker-selection-attestation', 'real worker provider/model/thinking receipt missing or substituted');
    const config = configs(home).find(row => row.value.run?.runId === runId)?.value;
    check(config && config.runtime.piVersion === summary.versions.repositorySdk, 'worker-version', 'runtime worker version not the explicit repo pin');
    result.checks.actualPiWorker = provider.receipts.some(receipt => receipt.step === 'broker');
    check(result.checks.actualPiWorker && workerFiles(home).length > 0 && processes.observed.size > 0, 'actual-worker', 'no real Pi worker/bridge/PID evidence');
    stage = 'qualified-report';
    const report = await invoke(`/p2o report ${runId}`); result.report = report;
    if (report.error) fail(stage, report.error);
    // The qualified report must carry the WORKER-DECLARED limitation text verbatim, not a keyword.
    const reportText = JSON.stringify(report.outcome);
    check(UNTESTED_SCOPE.every(limit => reportText.includes(limit)), stage, 'qualified report did not preserve the packet-declared inert/static limitation text verbatim');
    check(/incomplete|bounded/i.test(reportText), stage, 'qualified report does not declare its bounded/incomplete status');
    check(!status.findings?.some(row => ['reproduced', 'verified', 'independently-validated'].includes(row.state)), 'findings-classification', 'inert bounded packet was upgraded to a replayed/verified vulnerability');
    result.verification = { packetGate: 'real durable accepted packet', findings: status.findings ?? [],
      independentReplay: 'NOT invoked: first-use default has no verifier task/replay plan; do not claim exploit verification' };
    const toolResults = provider.receipts.flatMap(receipt => transcriptResults(receipt.body?.messages ?? []));
    result.brokerEvidence = [...new Map(toolResults.filter(row => row.name === 'p2o_broker' && row.value?.evidenceId)
      .map(row => [row.value.evidenceId, row.value])).values()];
    save(join(folder, 'broker-evidence.json'), result.brokerEvidence);
    check(result.brokerEvidence.length > 0, 'real-broker-collector', 'no real broker collector evidence admitted');
    if (kind !== 'url') {
      const path = kind === 'github' ? 'README' : 'index.ts';
      const expected = sha256(kind === 'github' ? 'Hello World!\n' : content);
      check(result.brokerEvidence.some(row => row.data?.files?.some(file => file.path === path && file.sha256 === expected)),
        'production-mounted-source-readback', 'production broker source output did not authenticate actual selected source bytes');
    }
    if (kind !== 'url') {
      check(config.sandbox.options.inputRoot !== source && config.sandbox.options.approvedSource?.snapshot?.root === config.sandbox.options.inputRoot, 'actual-source-mount', 'production runtime is not bound to the acquired immutable tree');
      check(docker.containers.size > 0, 'real-Docker', 'no observed actual production Docker container');
      check([...docker.containers.values()].some(inspect => inspect.Image === lock.image.pin && inspect.Config?.User === '65532:65532' &&
        inspect.HostConfig?.NetworkMode === 'none' && inspect.HostConfig?.ReadonlyRootfs === true &&
        inspect.Mounts?.some(mount => mount.Destination === '/inputs' && mount.Source === config.sandbox.options.inputRoot && mount.RW === false)),
        'real-production-readonly-mount', 'no actual inspected pinned production container carried the approved source tree read-only');
      const identity = jsonArtifacts(home).find(row => row.path.endsWith('/control/source-approval.json'))?.value;
      result.sourceApproval = identity;
      check(identity?.sourceUIConfirmed === true, 'immutable-source-ui', 'no actual source-identity approval receipt');
      if (kind === 'github') {
        check(identity.source?.revision === GITHUB_COMMIT, 'pinned-GitHub-commit', 'actual source commit differs from the user-authorized full pin');
        result.checks.livePublicGitHubHttps = true; result.githubCommit = GITHUB_COMMIT;
        result.canary = dockerCanary(config, 'README', sha256('Hello World!\n'), commandsPath);
      } else {
        const planning = provider.receipts.find(receipt => receipt.step === 'plan');
        check(!JSON.stringify(planning?.body).includes(marker), 'source-canary-not-in-plan', 'canary appeared in the planning prompt');
        // Deliberate harness-only original drift AFTER acquisition. Restore exact bytes afterwards.
        writeFileSync(join(source, 'index.ts'), 'export const harnessChangedOriginal = true;\n');
        try { result.canary = dockerCanary(config, 'index.ts', sha256(content), commandsPath); }
        finally { writeFileSync(join(source, 'index.ts'), content); }
        result.checks.snapshotSurvivesOriginalDrift = true;
        check(!existsSync(join(folder, 'SCRIPT_EXECUTED')), 'no-repository-execution', 'a target package script executed');
      }
    } else check(targetRequests.length === 1, 'bounded-loopback-target', `expected one exact request, observed ${targetRequests.length}`);
    result.checks.originalSourceUnmodifiedByApplication = true;
    let completionResources;
    for (let count = 0; count < 12; count++) {
      completionResources = { at: Date.now(), workers: processes.survivors(), containers: docker.absence() };
      if (completionResources.workers.length === 0 && completionResources.containers.every(row => row.absent)) break;
      await sleep(150);
    }
    save(join(folder, 'resources-after-completion.json'), completionResources);
    check(completionResources.workers.length === 0 && completionResources.containers.every(row => row.absent),
      'completion-resource-absence', 'reported completion left owned workers/containers alive before host shutdown');
    result.sessionReleaseReceipts = jsonArtifacts(home).filter(row => row.path.includes('/control/handles/')).map(row => row.value.sessionRelease).filter(Boolean);
    check(result.sessionReleaseReceipts.length > 0 && result.sessionReleaseReceipts.every(receipt => receipt.verified === true),
      'durable-session-release', 'actual handle lacks a verified session-release receipt');
    result.status = 'passed';
  } catch (error) {
    if (name === 'decline-plan' && error.message.includes('NOT_APPROVED')) {
      if (provider.receipts.length === 1 && targetRequests.length === 0 && workerFiles(home).length === 0 && docker?.containers.size === 0) {
        result.checks.declinedNoTargetOrWorkerSideEffects = true; result.checks.separateScopeConsentRemains = true; result.status = 'passed';
      } else { result.status = 'blocked'; result.blocker = { stage: 'declined-plan-side-effects', message: error.message }; }
    } else { result.status = 'blocked'; result.blocker = { stage: error.stage ?? stage, message: error.message }; }
  } finally {
    result.lastUIStage = rpc ? stageFor(rpc) : null;
    if (runId && rpc && !rpc.exit && result.status !== 'passed') {
      try { result.cleanupStop = await rpc.command(`/p2o stop ${runId}`); } catch (error) { result.cleanupStop = { error: error.message }; }
    }
    result.providerRequests = provider.receipts.length; result.providerErrors = provider.errors;
    result.targetRequests = targetRequests;
    save(join(folder, 'ui-prompts.json'), rpc?.prompts ?? []);
    const resourcesBeforeClose = { at: Date.now(), workers: processes?.survivors() ?? [], containers: docker?.absence() ?? [] };
    save(join(folder, 'resources-before-host-close.json'), resourcesBeforeClose);
    result.hostExit = await rpc?.close();
    await provider.close();
    if (targetServer) { targetServer.closeAllConnections(); await new Promise(resolve => targetServer.close(resolve)); }
    watcher?.kill('SIGTERM'); await sleep(150);
    processes?.close();
    result.resourcesAfterClose = { at: Date.now(), workers: processes?.survivors() ?? [], containers: docker?.absence() ?? [] };
    save(join(folder, 'resources-after-host-close.json'), result.resourcesAfterClose); docker?.close();
    if (result.resourcesAfterClose.workers.length || result.resourcesAfterClose.containers.some(row => !row.absent)) {
      result.status = 'blocked'; result.blocker ??= { stage: 'resource-cleanup', message: 'owned resource absence is unverified after actual session_shutdown; not repaired into a success' };
    }
    if (before) { const after = hashTree(source); save(join(folder, 'source-after.json'), after);
      if (JSON.stringify(before) !== JSON.stringify(after)) { result.status = 'blocked'; result.blocker = { stage: 'source-integrity', message: 'original source hashes changed' }; } }
    save(join(folder, 'application-artifacts-redacted.json'), jsonArtifacts(home));
    // Repo-access consent and the exact immutable-commit approval are distinct UI receipts; record both from
    // the real dialogs (the second one is what actually gates acquisition/worker dispatch).
    const prompts = rpc?.prompts ?? [];
    const repoAccess = prompts.find(row => (row.request?.title ?? '').startsWith('What is your authorization basis'));
    const commitApproval = prompts.find(row => (row.request?.title ?? '').startsWith('Approve immutable source'));
    result.approvals = {
      repoAccess: repoAccess ? {
        question: repoAccess.request.title,
        offeredOptions: repoAccess.request.options ?? null,
        answer: repoAccess.answer,
        qualificationAuthority: kind === 'github'
          ? 'public read-only fixed-commit clone: no push, issues, scans or repository execution'
          : 'harness-owned isolated fixture or source only',
        // Production offers own/control | written-permission | published-program. Flag when none of those
        // options expresses the qualification authority instead of presenting the selection as exact.
        basisOptionExpressesAuthority: kind === 'github'
          ? /public/i.test(repoAccess.answer?.value ?? '')
          : repoAccess.answer?.value === 'I own/control this target',
      } : null,
      immutableCommit: commitApproval ? {
        question: commitApproval.request.title,
        offeredCommit: /Commit: ([a-f0-9]{40}|[a-f0-9]{64})/.exec(commitApproval.request.message ?? '')?.[1] ?? null,
        authorizedCommit: kind === 'github' ? GITHUB_COMMIT : null,
        answer: commitApproval.answer,
      } : null,
    };
    save(join(folder, 'artifact-hashes.json'), hashTree(home));
    result.ended = Date.now(); if (result.blocker) summary.blockers.push({ case: name, ...result.blocker });
    save(join(folder, 'result.json'), result);
    console.log(`${result.status.toUpperCase()} ${name}${result.blocker ? `: ${result.blocker.stage}: ${result.blocker.message}` : ''}`);
  }
}

// --- LIVE model qualification (parent-authorized, bounded) -------------------------------------------
// Deliberately separate from the mechanical INERT suite: real installed host, real provider, real
// credential-owning gateway, real Pi worker. No plan/worker reply is stubbed and the deterministic
// fixture transport is never loaded (see live-extension.ts). Aggregate spend is hard-capped by the
// ledger below; one live run per target plus one bounded correction retry in total.
const LIVE = Object.freeze({
  selection: { ...LIVE_SELECTION },
  evidenceClass: 'live-real-provider-model-calls-deepseek-flash-max-no-independent-verification',
  // Production validates owner USD limits as at most two decimals, including the quarter reserved for planning
  // and the worker remainder after it. 0.32 -> 0.08 / 0.24 keeps every derived value representable; 0.30
  // produced 0.075 / 0.225 and failed closed (observed once, tracked as a harness defect, not a model failure).
  perRun: { usd: 0.32, tokens: 130_000, requests: 1, toolCalls: 8, attempts: 1, concurrency: 1, deadlineMinutes: 5 },
  aggregate: { usd: 1, tokens: 400_000, correctionRetries: 1 },
  price: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 }, // pinned catalog values for deepseek/deepseek-flash
});
let liveCredential, liveSummary, liveLedger;

/** Read the installed Pi auth store in memory. The value is never printed, logged, copied or persisted by the harness. */
function resolveLiveCredential() {
  const path = process.env.P2O_QUALIFICATION_LIVE_AGENT_DIR
    ? join(process.env.P2O_QUALIFICATION_LIVE_AGENT_DIR, 'auth.json') : join(homedir(), '.pi/agent/auth.json');
  if (!existsSync(path)) throw Object.assign(new Error(`LIVE_CREDENTIAL_UNAVAILABLE: no Pi auth store at ${path}`), { stage: 'live-credential' });
  const entry = JSON.parse(readFileSync(path, 'utf8'))?.[LIVE.selection.provider];
  if (entry?.type !== 'api_key' || typeof entry.key !== 'string' || entry.key.length === 0) {
    throw Object.assign(new Error(`LIVE_CREDENTIAL_UNAVAILABLE: no api_key entry for ${LIVE.selection.provider}`), { stage: 'live-credential' });
  }
  return { key: entry.key, source: path, sourceKind: 'installed-pi-auth-store-read-in-memory' };
}

const liveLedgerPath = () => join(root, 'live-attempts.json');
function liveLedgerLoad() {
  const base = { schemaVersion: 1, policy: 'one live run per target plus one bounded correction retry total',
    attempts: {}, corrections: 0, spend: { usd: 0, tokens: 0 }, cases: [], grants: [] };
  if (!existsSync(liveLedgerPath())) return { path: liveLedgerPath(), value: base };
  return { path: liveLedgerPath(), value: { ...base, ...JSON.parse(readFileSync(liveLedgerPath(), 'utf8')) } };
}
function liveBudgetFor(name) {
  const ledger = liveLedger.value;
  const remainingUsd = LIVE.aggregate.usd - ledger.spend.usd, remainingTokens = LIVE.aggregate.tokens - ledger.spend.tokens;
  if (remainingUsd < 0.02 || remainingTokens < 5_000) {
    throw Object.assign(new Error(`LIVE_AGGREGATE_CAP_REACHED: spent $${ledger.spend.usd.toFixed(4)} / ${ledger.spend.tokens} tokens; no further live run`), { stage: 'live-budget' });
  }
  const attempt = (ledger.attempts[name] ?? 0) + 1;
  if (attempt > 1) {
    // An explicit one-shot owner grant (e.g. the post-refreeze URL retry) authorizes a further attempt without
    // rewriting history: the consumption is stamped into the ledger so the allowance cannot be reused.
    const grant = (ledger.grants ?? []).find(entry => !entry.used && (entry.targets?.[name] ?? 0) > 0);
    if (grant) {
      grant.targets[name] -= 1;
      grant.consumed = [...(grant.consumed ?? []), { at: new Date().toISOString(), target: name, attempt }];
      grant.used = Object.values(grant.targets).every(value => value <= 0);
    } else if (ledger.corrections >= LIVE.aggregate.correctionRetries) {
      throw Object.assign(new Error(`LIVE_ATTEMPT_CAP_REACHED: ${name} already ran and the single bounded correction retry is used`), { stage: 'live-attempt-cap' });
    } else {
      ledger.corrections += 1;
    }
  }
  ledger.attempts[name] = attempt;
  return { ...LIVE.perRun, usd: Math.min(LIVE.perRun.usd, Math.floor(remainingUsd * 100) / 100), tokens: Math.min(LIVE.perRun.tokens, remainingTokens), attempt };
}

function readJsonl(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function workerSessions(home) {
  return walk(home, 20_000).filter(path => path.endsWith('/session.jsonl') && !path.includes('/entry-views/'));
}
/** Durable live spend: planning receipt (host-computed with the pinned price) + worker session turns. */
function liveSpendOf(home) {
  const planning = jsonArtifacts(home).find(row => row.path.endsWith('/control/planning-spend.json'))?.value;
  const receipts = planning?.receipts ?? [];
  const planTokens = receipts.reduce((sum, row) => sum + (row.usage?.totalTokens ?? 0), 0);
  const planUsd = receipts.reduce((sum, row) => sum + (row.usage?.cost?.total ?? 0), 0);
  let workerInput = 0, workerOutput = 0, workerTurns = 0, workerUsdReported = 0;
  for (const file of workerSessions(home)) {
    for (const row of readJsonl(file)) {
      const usage = row?.message?.usage;
      if (row?.message?.role !== 'assistant' || !usage) continue;
      workerTurns += 1; workerInput += usage.input ?? 0; workerOutput += usage.output ?? 0; workerUsdReported += usage.cost?.total ?? 0;
    }
  }
  const workerUsdPinned = (workerInput * LIVE.price.inputUsdPerMillion + workerOutput * LIVE.price.outputUsdPerMillion) / 1e6;
  const tokens = planTokens + workerInput + workerOutput;
  const usd = planUsd + Math.max(workerUsdReported, workerUsdPinned);
  return { planTokens, planUsd, workerTurns, workerInput, workerOutput, workerUsdReported, workerUsdPinned,
    tokens, usd, usdBasis: 'planning receipt cost + max(reported, pinned-price recomputation) for worker turns' };
}
/** Remove any host-persisted copy of the live credential, then prove no copy remains under the artifact root. */
function scrubSecret(folder, secret) {
  const contains = path => { try { return readFileSync(path, 'utf8').includes(secret); } catch { return false; } };
  const hit = walk(folder, 20_000).filter(contains);
  for (const path of hit) { try { rmSync(path, { force: true }); } catch { /* reported as residue below */ } }
  const residue = walk(folder, 20_000).filter(contains);
  return { removed: [...new Set(hit)].map(path => path.replace(folder, '~')), residue: residue.map(path => path.replace(folder, '~')) };
}

async function runLiveCase(name) {
  // Attempt-scoped folder: a corrective retry never overwrites the failed attempt's evidence, and the ledger
  // attempt number is the single source of truth for which run this is.
  const limits = livePreflight ? { ...LIVE.perRun, attempt: 0 } : liveBudgetFor(name);
  const folder = join(root, `${name}-attempt${limits.attempt}`); mkdirSync(folder, { mode: 0o700 });
  const home = join(folder, 'home'), agent = join(home, '.pi/agent'), cwd = join(folder, 'workspace');
  for (const path of [home, agent, cwd]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const kind = name === 'github' ? 'github' : name === 'local' ? 'local' : 'url';
  const result = { name, mode: 'live', started: Date.now(), status: 'running', evidenceClass: LIVE.evidenceClass,
    selection: { ...LIVE.selection }, ownerLimits: limits, attempt: limits.attempt, home,
    noConfigurationPreseeded: walk(home).length === 0, commands: [], checks: [], limitations: {
      independentVerification: 'NOT invoked: first-use default has no verifier task/replay plan; a live model call is not exploit verification',
      liveClaim: 'real provider model calls for this bounded fixture; not a claim about model quality or about the implementation session model',
      data: 'only the harness-owned fixture or public octocat source was sent; no private project data',
    } };
  liveSummary.cases.push(result);
  let rpc, targetServer, runId, docker, processes;
  const secret = liveCredential.key, targetRequests = [];
  try {
    const source = join(folder, 'target-source');
    const marker = `LIVE_CANARY_${crypto.randomUUID()}`;
    const content = `export const canary = "${marker}";\nexport function render(input) { return input; }\n`;
    let target;
    if (kind === 'url') {
      targetServer = createServer((request, response) => {
        const receipt = { at: Date.now(), method: request.method, path: request.url }; targetRequests.push(receipt);
        append(join(folder, 'target-requests.jsonl'), receipt);
        if (request.method !== 'GET' || request.url !== '/exact') { response.writeHead(403).end(); return; }
        response.writeHead(200, { 'content-type': 'text/plain', 'x-qualification': 'owned-loopback-target-live' }).end('Benign qualification fixture. No vulnerability claim.');
      });
      await new Promise(done => targetServer.listen(0, '127.0.0.1', done));
      target = `http://127.0.0.1:${targetServer.address().port}/exact`;
    } else if (kind === 'github') {
      target = GITHUB;
    } else {
      target = source; mkdirSync(source, { mode: 0o700 });
      writeFileSync(join(source, 'index.ts'), content);
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'live-untrusted-source', scripts: {
        postinstall: `node -e "require('fs').writeFileSync('${join(folder, 'SCRIPT_EXECUTED')}','bad')"` } }));
    }
    result.target = target; result.canarySha256 = kind === 'local' ? sha256(content) : null;
    const env = { HOME: home, USER: process.env.USER ?? 'qualification', LOGNAME: process.env.LOGNAME ?? 'qualification',
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', TERM: 'dumb', TMPDIR: folder,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'),
      PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      [LIVE.selection.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'LIVE_PROVIDER_API_KEY']: secret,
    };
    result.environmentKeys = Object.keys(env).sort(); // key names only; no value is ever recorded
    const args = ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
      '--no-themes', '--no-context-files', '--no-tools', '--no-approve', '--extension', join(import.meta.dirname, 'live-extension.ts'),
      '--provider', LIVE.selection.provider, '--model', LIVE.selection.model, '--thinking', LIVE.selection.thinking];
    rpc = new PiRpc({ binary, args, cwd, env, kind, live: LIVE.selection, liveLimits: limits, preflight: livePreflight,
      log: join(folder, 'rpc.jsonl'), stderrPath: join(folder, 'host.stderr'),
      beforeDialog: async request => {
        append(join(folder, 'approval-boundaries.jsonl'), { at: Date.now(), title: request.title,
          targetRequests: targetRequests.length, workerConfigs: workerFiles(home).length, containers: docker?.containers.size ?? 0 });
        if (request.title?.startsWith('Approve p2o') || request.title?.startsWith('Approve plan ')) {
          check(targetRequests.length === 0, 'live-pre-plan-approval-side-effects', 'live target contacted before model-plan approval');
          check(workerFiles(home).length === 0, 'live-pre-plan-approval-side-effects', 'live worker launched before model-plan approval');
        }
      } });
    processes = observeProcesses(home, rpc.child.pid, join(folder, 'processes.jsonl'));
    docker = observeDocker(home, lock.image.pin, join(folder, 'docker-events.jsonl'), commandsPath);
    const state = await rpc.request('get_state', {}, 25_000); result.hostState = state;
    check(state.success && state.data?.model?.provider === LIVE.selection.provider && state.data?.model?.id === LIVE.selection.model,
      'live-host-selection', `installed host selected ${state.data?.model?.provider}/${state.data?.model?.id}; never substitute`);
    check(state.data?.thinkingLevel === LIVE.selection.thinking, 'live-thinking-selection',
      `host thinking ${state.data?.thinkingLevel} is not the authorized ${LIVE.selection.thinking}; no downgrade`);
    const commands = await rpc.request('get_commands');
    check(commands.data?.commands?.some(item => item.name === 'p2o'), 'live-command-registration', 'real p2o command registration missing');
    await rpc.request('set_auto_retry', { enabled: false }); await rpc.request('set_auto_compaction', { enabled: false });
    const invoke = async text => { result.commands.push({ at: Date.now(), text }); const receipt = await rpc.command(text); append(join(folder, 'command-receipts.jsonl'), { text, ...receipt }); return receipt; };
    const planned = await invoke(`/p2o --target ${JSON.stringify(target)}${kind === 'url' ? ' --plan-only' : ''}`);
    result.initialOutcome = planned;
    if (livePreflight) {
      const modelDialog = (rpc.prompts ?? []).find(row => (row.request?.title ?? '').startsWith('Assessment model'));
      const thinkingDialog = (rpc.prompts ?? []).find(row => (row.request?.title ?? '').startsWith('Assessment thinking'));
      const modelOptions = modelDialog?.request?.options ?? [];
      check(modelOptions.some(option => option.startsWith(`${LIVE.selection.provider}/${LIVE.selection.model}`) && !option.includes('BLOCKED')),
        'live-preflight-model-available', `authorized model not offered by the installed host: ${JSON.stringify(modelOptions.slice(0, 4))}`);
      check(String(modelDialog?.answer?.value).startsWith(`${LIVE.selection.provider}/${LIVE.selection.model}`), 'live-preflight-model-selected',
        `preflight did not answer the model dialog with the authorized selection: ${modelDialog?.answer?.value ?? 'absent'}`);
      const thinkingOptions = thinkingDialog?.request?.options ?? [];
      check(thinkingOptions.includes(LIVE.selection.thinking), 'live-preflight-thinking-available',
        `authorized thinking level not offered by the installed host: ${JSON.stringify(thinkingOptions)}`);
      check(String(planned.error).includes('CANCELLED'), 'live-preflight-abort', `preflight did not abort at the thinking dialog: ${planned.error ?? 'no error'}`);
      check(!jsonArtifacts(home).some(row => row.path.endsWith('/control/planning-spend.json')), 'live-preflight-no-planning', 'preflight produced a planning receipt');
      result.preflight = { modelOptions: modelOptions.slice(0, 6), thinkingOptions, modelSelected: modelDialog?.answer?.value ?? null, aborted: true, providerCallMade: false };
      result.checks.push('livePreflightNoProviderCall');
      result.status = 'passed'; return;
    }
    if (planned.error) fail(stageFor(rpc), planned.error);
    const modelDialog = (rpc.prompts ?? []).find(row => (row.request?.title ?? '').startsWith('Assessment model'));
    const thinkingDialog = (rpc.prompts ?? []).find(row => (row.request?.title ?? '').startsWith('Assessment thinking'));
    result.uiSelections = { model: modelDialog?.answer?.value ?? null, thinking: thinkingDialog?.answer?.value ?? null };
    check(String(result.uiSelections.model).startsWith(`${LIVE.selection.provider}/${LIVE.selection.model}`), 'live-ui-model',
      `assessment-model dialog did not confirm the authorized selection: ${result.uiSelections.model ?? (modelDialog?.answer?.reason ?? 'absent')}`);
    check(result.uiSelections.thinking === LIVE.selection.thinking, 'live-ui-thinking',
      `thinking dialog did not confirm ${LIVE.selection.thinking}: ${result.uiSelections.thinking ?? (thinkingDialog?.answer?.reason ?? 'absent')}`);
    const planning = jsonArtifacts(home).find(row => row.path.endsWith('/control/planning-spend.json'))?.value;
    const planReceipt = (planning?.receipts ?? []).find(row => row.usage && row.usage.totalTokens > 0);
    check(planReceipt, 'live-planning-receipt', 'no durable planning receipt with real provider usage; the planning call is unproven');
    check(planReceipt.selection?.provider === LIVE.selection.provider && planReceipt.selection?.model === LIVE.selection.model && planReceipt.selection?.thinking === LIVE.selection.thinking,
      'live-planning-selection', 'planning receipt selection differs from the authorized live selection');
    check(planReceipt.usage.cost?.total > 0, 'live-planning-cost', 'planning receipt reports no provider cost; live spend cannot be bounded');
    result.planningReceipt = planReceipt;
    runId = planned.outcome?.details?.runId; result.runId = runId;
    check(runId, stageFor(rpc), 'no sealed plan/run receipt in the live host session');
    if (kind === 'url') {
      check(planned.outcome?.details?.planOnly === true && targetRequests.length === 0 && workerFiles(home).length === 0 && docker.containers.size === 0,
        'live-plan-only-side-effects', 'live plan-only touched the target, a worker or a container');
      const approved = await invoke(`/p2o approve ${planned.outcome.details.planId}`); result.approvalOutcome = approved;
      if (approved.error) fail(stageFor(rpc), approved.error);
      check(String(approved.outcome?.content ?? '').includes('admitted once'), 'live-plan-approved', 'live plan approval did not admit the run exactly once');
    } else {
      const planDialog = (rpc.prompts ?? []).find(row => (row.request?.title ?? '').startsWith('Approve p2o run') || (row.request?.title ?? '').startsWith('Approve plan '));
      check(planDialog?.answer?.confirmed === true, 'live-plan-approved', 'live plan was not approved in the real UI');
    }
    let status;
    for (let count = 0; count < 600; count++) {
      const read = await invoke(`/p2o status ${runId}`); if (read.error) fail('live-supervisor', read.error);
      status = read.outcome?.details?.result;
      if (['completed', 'failed', 'cancelled'].includes(status?.run?.state)) break;
      await sleep(500);
    }
    result.finalStatus = status;
    check(status?.run?.state === 'completed', 'live-supervisor', `live run ${status?.run?.state ?? 'unknown'}; ${JSON.stringify(status?.failures ?? [])}`);
    const attempts = status?.process?.attempts ?? [];
    const admitted = (status?.packets ?? []).filter(row => row.decision?.status === 'accepted');
    check(attempts.length > 0 && admitted.length > 0, 'live-packet-admission', `live worker did not yield an accepted packet (attempts ${attempts.length}, accepted ${admitted.length})`);
    check(attempts.every(attempt => attempt.observedRuntime?.attestation === 'attested' && attempt.observedRuntime?.selection?.provider === LIVE.selection.provider && attempt.observedRuntime?.selection?.model === LIVE.selection.model && attempt.observedRuntime?.selection?.thinking === LIVE.selection.thinking),
      'live-worker-attestation', 'live worker runtime attestation/selection missing or substituted');
    check((status.findings ?? []).every(finding => !['reproduced', 'verified', 'independently-validated'].includes(finding.state)), 'live-findings-classification',
      'live run upgraded a bounded observation into a replayed/verified vulnerability');
    const sessions = workerSessions(home);
    const turns = sessions.flatMap(file => readJsonl(file)).filter(row => row?.message?.role === 'assistant' && row.message.usage);
    const liveTurns = turns.filter(row => row.message.provider === LIVE.selection.provider && row.message.model === LIVE.selection.model);
    result.workerTurns = { total: turns.length, live: liveTurns.length, sessions: sessions.map(path => path.replace(home, '~')) };
    check(liveTurns.length > 0, 'live-worker-model-turns', 'no durably receipted live worker model turn in the worker session');
    // Actual worker/broker criterion: the live model itself must drive the collector, and a URL run must have
    // made exactly the one approved request.
    const brokerCalls = sessions.flatMap(file => readJsonl(file))
      .flatMap(row => row?.message?.content ?? [])
      .filter(block => block?.type === 'toolCall' && block?.name === 'p2o_broker');
    result.brokerCalls = brokerCalls.length;
    check(brokerCalls.length > 0, 'live-worker-broker', 'live worker session has no p2o_broker collector call');
    if (kind === 'url') check(targetRequests.length === 1, 'live-bounded-target', `expected exactly one approved loopback request, observed ${targetRequests.length}`);
    const report = await invoke(`/p2o report ${runId}`); result.report = report;
    if (report.error) fail('live-report', report.error);
    const reportText = JSON.stringify(report.outcome);
    check(/incomplete|bounded/i.test(reportText), 'live-report-bounded', 'live report does not declare its bounded/incomplete status');
    result.verification = { packetGate: 'real durable accepted packet', findings: status.findings ?? [],
      independentReplay: 'NOT invoked: first-use default has no verifier task/replay plan; a live model call is not exploit verification',
      livePlanningReceipt: planReceipt.usage, liveWorkerTurns: liveTurns.length };
    // Success counts only when every owner-listed criterion holds in durable evidence; cleanupVerified is set
    // in the finally block from the ownership-scoped resource check (never inferred from an empty map).
    result.successCriteria = { planApproved: true, actualWorkerBroker: brokerCalls.length > 0,
      packetAccepted: admitted.length > 0, reportExists: !report.error && !!report.outcome, cleanupVerified: false,
      liveWorkerTurns: liveTurns.length, liveProviderTurns: liveTurns.length + 1 };
    result.status = 'passed';
  } catch (error) {
    result.status = 'blocked'; result.blocker = { stage: error.stage ?? 'live', message: error.message };
  } finally {
    result.lastUIStage = rpc ? stageFor(rpc) : null;
    if (runId && rpc && !rpc.exit && result.status !== 'passed') {
      try { result.cleanupStop = await rpc.command(`/p2o stop ${runId}`); } catch (error) { result.cleanupStop = { error: error.message }; }
    }
    save(join(folder, 'ui-prompts.json'), rpc?.prompts ?? []);
    result.hostExit = await rpc?.close();
    if (targetServer) { targetServer.closeAllConnections(); await new Promise(done => targetServer.close(done)); }
    processes?.close();
    result.resourcesAfterClose = { at: Date.now(), workers: processes?.survivors() ?? [], containers: docker?.absence() ?? [] };
    docker?.close();
    if (result.successCriteria) result.successCriteria.cleanupVerified = !(result.resourcesAfterClose.workers.length || result.resourcesAfterClose.containers.some(row => !row.absent));
    if (result.resourcesAfterClose.workers.length || result.resourcesAfterClose.containers.some(row => !row.absent)) {
      result.status = 'blocked'; result.blocker ??= { stage: 'live-resource-cleanup', message: 'owned resource absence unverified after host shutdown' };
    }
    result.spend = liveSpendOf(home);
    if (!livePreflight) { liveLedger.value.spend.usd += result.spend.usd; liveLedger.value.spend.tokens += result.spend.tokens; }
    result.credentialScrub = scrubSecret(folder, secret);
    if (result.credentialScrub.residue.length) { result.status = 'blocked'; result.blocker ??= { stage: 'live-secret-residue', message: 'credential value still present in artifacts' }; }
    save(join(folder, 'artifact-hashes.json'), hashTree(home));
    save(join(folder, 'result.json'), result);
    liveLedger.value.cases.push({ name, status: result.status, attempt: result.attempt, preflight: livePreflight, spend: result.spend, scrub: result.credentialScrub });
    save(liveLedger.path, liveLedger.value);
    console.log(`${result.status.toUpperCase()} live ${name}${result.blocker ? `: ${result.blocker.stage}: ${result.blocker.message}` : ` ($${result.spend.usd.toFixed(4)}, ${result.spend.tokens} tokens)`}`);
  }
}

function liveHandoff() {
  liveSummary.endedAt = new Date().toISOString();
  liveSummary.ledger = { attempts: liveLedger.value.attempts, corrections: liveLedger.value.corrections, grants: liveLedger.value.grants ?? [], spend: liveLedger.value.spend };
  // Freeze integrity: the tree was frozen before qualification; any source drift pauses the claim instead of
  // being silently absorbed into a passing result.
  const before = JSON.parse(readFileSync(join(root, 'source-hashes-start.json'), 'utf8'));
  const after = sourceInventory();
  save(join(root, 'source-hashes-end.json'), after);
  const index = rows => Object.fromEntries(rows.map(row => [row.path, row.sha256]));
  const start = index(before), end = index(after);
  const driftedFiles = [...new Set([...Object.keys(start), ...Object.keys(end)])].filter(path => start[path] !== end[path]);
  liveSummary.sourceControl = { scope: 'src, extensions, containers (excluding containers/build)', start: 'source-hashes-start.json', end: 'source-hashes-end.json', driftedFiles };
  if (driftedFiles.length) liveSummary.blockers.push({ case: 'source-drift', stage: 'qualification-freeze', message: `source drifted during live qualification: ${driftedFiles.join(', ')}` });
  liveSummary.exitCode = (liveSummary.cases.some(row => row.status !== 'passed') || driftedFiles.length) ? 1 : 0;
  save(join(root, 'summary.json'), liveSummary);
  const rows = liveSummary.cases.map(row => `| ${row.name} | ${row.status} | ${row.blocker ? `${row.blocker.stage}: ${row.blocker.message}` : `accepted live worker packet; $${row.spend.usd.toFixed(4)} / ${row.spend.tokens} tokens; ${row.workerTurns?.live ?? 0} live worker turns`} |`).join('\n');
  const report = `# p2o LIVE model qualification (parent-authorized, frozen tree)\n\nArtifacts: \`${root}\`\nExit: **${liveSummary.exitCode}**. Selection **${LIVE.selection.provider}/${LIVE.selection.model}/${LIVE.selection.thinking}**, explicitly confirmed in the real UI. Aggregate cap $${LIVE.aggregate.usd} / ${LIVE.aggregate.tokens} tokens; one run per target plus one correction retry.\n\nFreeze integrity: source drift during qualification = ${driftedFiles.length ? driftedFiles.join(', ') : 'none'} (src/extensions/containers, recorded hashes start→end).\n\n**These are real provider model calls, not the inert fixture.** Automated consent simulation (\`${LIVE_CONSENT_LABEL}\`), not a human-operated UI claim. The credential was read from the installed Pi auth store in memory and injected for the host only; it is never printed, and any host-persisted copy is removed before archiving (\`credentialScrub\`, residue-audited). Workers use the production loopback credential-owning gateway and never receive the raw key. Raw metadata (host state, planning receipts, worker sessions, usage) and worker results (packets, findings, report) are reported separately.\n\n| target | result | detail |\n|---|---|---|\n${rows}\n\nSpend (durable receipts, includes failed runs): ${JSON.stringify(liveLedger.value.spend)}. **No independent verification is claimed**: a live model call and an accepted packet are not exploit replay. If a case is blocked, the exact stage is in its \`result.json\`; nothing is repaired into a success.\n`;
  writeFileSync('/tmp/p2o-qualification-live-handoff.md', report, { mode: 0o600 });
  console.log(`LIVE ARTIFACTS ${root}\nLIVE HANDOFF /tmp/p2o-qualification-live-handoff.md`);
  process.exitCode = liveSummary.exitCode;
}

function handoff() {
  summary.endedAt = new Date().toISOString(); summary.exitCode = summary.blockers.length ? 1 : 0;
  save(join(root, 'summary.json'), summary); save(join(root, 'source-hashes-end.json'), sourceInventory());
  const rows = summary.cases.map(row => `| ${row.name} | ${row.status} | ${row.blocker ? `${row.blocker.stage}: ${row.blocker.message.replace(/\n/g, ' ').slice(0, 900)}` : `${row.providerRequests} inert exchanges; host exit ${JSON.stringify(row.hostExit)}`} |`).join('\n');
  const implementation = `${summary.implementationSelection.provider}/${summary.implementationSelection.model}/${summary.implementationSelection.thinking}`;
  const report = `# Independent first-use qualification handoff\n\nArtifacts: \`${root}\`\nCommand: \`node tests/qualification-first-use/run.mjs ${process.argv.slice(2).join(' ')}\`\nExit: **${summary.exitCode}**. Actual installed host ${summary.versions.hostPi.stdout.trim()} / repo worker ${summary.versions.workerPi.stdout.trim()}. Node ${process.version}; Docker ${lock.engineVersion}; pinned image ${lock.image.pin}.\n\n**Evidence is deterministic INERT PROVIDER, NOT live AI.** Actual extension host RPC dialogs answered by **${CONSENT_LABEL}**, not a human operated UI claim. No backend/entry/runtime replacement or manual application JSON. No paid provider call. Invoking implementation session was ${implementation} (recorded from its own env, not inferred); it is NOT relabeled as the inert assessment model, and the actual host/worker models below come only from receipts (versions, hostState, worker config, planning receipts, worker sessions).\n\n| case | observed result | detail |\n|---|---|---|\n${rows}\n\nLive blockers: ${summary.live.blockers.join(' ')}\n\nReceipts: commands.jsonl (invocation/exit codes/versions), source-hashes-{start,end}.json, per-case rpc.jsonl/ui-prompts.json/approval-boundaries.jsonl, provider.jsonl (synthetic usage), process kernel identities, Docker exact IDs/mounts/events, command receipts/status/report, redacted application/source/approval/lifecycle receipts, source hashes, resources before/after shutdown. Additional same-mount Docker canary is identified separately from the actual application tool path. No container pulls/builds or repository scripts. Inotify observes source OPEN/ACCESS/writes, **not stat syscalls or complete network telemetry**. Unknown/declined stage is never a mock success. Resource cleanup uses only exact owned identities; no pkill.\n`;
  writeFileSync('/tmp/p2o-qualification-handoff.md', report, { mode: 0o600 });
  writeFileSync('/tmp/p2o-qualification-blockers.md', `# Qualification blockers — ${summary.endedAt}\n\nReal host ${summary.versions.hostPi.stdout.trim()}, default registerP2O; all P2O_CONFIG/app/control overrides unset; exact evidence \`${root}/summary.json\`.\n\n${summary.blockers.map(row => `- **${row.case} / ${row.stage}**: ${row.message}\n`).join('\n') || 'No mechanical blockers in the cases that actually ran. Live qualification is NOT claimed.'}\n\nNo paid/model fallback. ${summary.live.blockers.join(' ')}\n`, { mode: 0o600 });
  console.log(`ARTIFACTS ${root}\nHANDOFF /tmp/p2o-qualification-handoff.md`);
  process.exitCode = summary.exitCode;
}

if (flag('--require-live')) {
  summary.assessmentSelection = { ...LIVE_SELECTION }; summary.evidenceClass = 'live-readiness-only-NO-provider-call';
  summary.blockers.push({ case: 'live-readiness', stage: 'live-opt-in-and-freeze-signal', message: summary.live.blockers.join(' ') });
  handoff();
} else if (flag('--live')) {
  const requested = option('--case');
  if (!requested) throw new Error('LIVE_CASE_REQUIRED: pass --case url|local|github; live mode never runs the default set');
  if (!['url', 'local', 'github'].includes(requested)) throw new Error(`LIVE_CASE_UNKNOWN: ${requested}; live targets are url|local|github`);
  if (requested !== 'github' && flag('--github')) throw new Error('LIVE_FLAG_CONFLICT: --github applies only to --case github');
  if (requested === 'github' && !flag('--github')) throw new Error('GITHUB_OPT_IN_REQUIRED: pass --github for the authorized bounded fixed-public-repo HTTPS case');
  liveCredential = resolveLiveCredential();
  // Fail fast on a self-inflicted limit shape before any spend: the owner cap, its planning quarter and the
  // worker remainder must all be at most two decimals or production onboarding refuses the config.
  {
    const twoDecimals = value => Math.abs(value * 100 - Math.round(value * 100)) <= 1e-7;
    const usd = LIVE.perRun.usd;
    if (![usd, usd / 4, usd - usd / 4, LIVE.aggregate.usd].every(twoDecimals)) {
      throw new Error(`LIVE_LIMIT_SHAPE_INVALID: usd ${usd} (quarter ${usd / 4}, remainder ${usd - usd / 4}) or aggregate ${LIVE.aggregate.usd} exceeds two decimals`);
    }
  }
  liveLedger = liveLedgerLoad();
  liveSummary = { schemaVersion: 1, mode: 'live', startedAt: new Date().toISOString(), artifacts: root,
    selection: { ...LIVE.selection }, evidenceClass: LIVE.evidenceClass, consent: LIVE_CONSENT_LABEL,
    aggregate: { ...LIVE.aggregate }, limits: { ...LIVE.perRun }, cases: [], blockers: [],
    credential: { source: liveCredential.source, sourceKind: liveCredential.sourceKind, valueLogged: false, persistedByHarness: false },
    sourceControl: summary.sourceControl, versions: summary.versions, containerLock: summary.containerLock };
  await runLiveCase(requested);
  liveHandoff();
} else {
  const requested = option('--case');
  // `stop-resume` is a deprecated alias for the negative stale-reuse case: stop is terminal in production.
  const alias = { 'stop-resume': 'stop-stale-reuse' };
  const resolved = requested ? (alias[requested] ?? requested) : undefined;
  const names = resolved ? [resolved] : ['decline-onboarding', 'decline-plan', 'url', 'local', 'stop-stale-reuse', ...(flag('--github') ? ['github'] : [])];
  for (const name of names) {
    assert(['decline-onboarding', 'decline-plan', 'url', 'local', 'github', 'stop-stale-reuse'].includes(name), `UNKNOWN_CASE: ${name}`);
    if (name === 'github' && !flag('--github')) throw new Error('GITHUB_OPT_IN_REQUIRED: pass --github for the authorized bounded fixed-public-repo HTTPS case');
    await runCase(name);
  }
  handoff();
}

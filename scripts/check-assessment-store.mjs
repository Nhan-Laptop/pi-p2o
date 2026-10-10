// Native driver/FD/readonly qualification. No target/provider/worker/reference activity.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const source = process.argv.includes('--source');
const countArgument = process.argv.find(arg => arg.startsWith('--records='));
const count = countArgument ? Number(countArgument.slice('--records='.length)) : 32;
if (![32, 10000, 100000].includes(count)) throw Error('Use --records=10000 or --records=100000 for explicitly bounded history measurements');
let AssessmentStore;
if (source) {
  const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const { createJiti } = require('jiti');
  ({ AssessmentStore } = await createJiti(import.meta.url).import(new URL('../src/state/store.ts', import.meta.url).pathname));
} else ({ AssessmentStore } = await import('../dist/src/state/store.js'));
const root = await mkdtemp(join(tmpdir(), 'p2o-native-store-'));
let store;
const manifest = { runId: 'run-native-fixture', retention: 'durable-local', targetKind: 'directory', targetIdentity: 'inert-fixture', targetDisplay: 'no assessment',
  profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } };
try {
  store = AssessmentStore.create(root, manifest);
  const commits = [], batchSize = count > 32 ? 100 : 1;
  for (let i = 0; i < count; i += batchSize) {
    const start = performance.now();
    store.commitRecords(Array.from({ length: Math.min(batchSize, count - i) }, (_, n) => ({ id: `record-${i + n}`, at: '2030', by: 'owner', kind: 'note', text: `inert ${i + n}` })));
    commits.push(performance.now() - start);
  }
  const queries = [];
  for (let i = 0; i < 32; i++) {
    const start = performance.now(), page = store.events({ since: 0, limit: 20 });
    assert.equal(page.total, count); assert.equal(page.shown, Math.min(20, count)); queries.push(performance.now() - start);
  }
  const start = performance.now(), checkpoint = store.checkpoint('native deterministic fixture'), checkpointMs = performance.now() - start;
  assert.equal(checkpoint.asOfSequence, count); assert.equal(store.inspectCheckpoint(checkpoint.id).integrityStatus, 'complete');
  const before = store.health(); store.close(); store = AssessmentStore.open(root, manifest.runId);
  assert.equal(store.record('record-0').text, 'inert 0'); assert.equal(store.health().authorityRestored, false);
  assert.throws(() => store.commitRecords([{ at: '2030', by: 'owner', kind: 'note', text: 'denied' }]), /read-only/);
  const sqlite = new DatabaseSync(':memory:'); const sqliteVersion = sqlite.prepare('SELECT sqlite_version() AS v').get().v; sqlite.close();
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
  console.log(JSON.stringify({ node: process.version, sqlite: sqliteVersion, loader: source ? 'Pi dependency jiti/source TS' : 'compiled ESM',
    corpus: { records: count, batchSize, fixture: 'inert deterministic notes/events, not assessment quality' }, journalMode: 'DELETE',
    mechanics: ['single canonical store', 'private pinned FD paths', 'atomic record/event/outbox writes', 'consistent checkpoint', 'knowledge-only readonly reopen'],
    performance: { commitBatchP50Ms: percentile(commits, .5), commitBatchP95Ms: percentile(commits, .95), eventQueryP50Ms: percentile(queries, .5), eventQueryP95Ms: percentile(queries, .95), checkpointMs },
    storage: before, rssBytes: process.memoryUsage().rss, hardware: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
    runtimeIntegrated: false, limitations: ['Store/adapter qualification only', 'No extension runtime acceptance in this store-only fixture', 'No paid/provider/live Herdr acceptance', 'No finding correctness or effectiveness claim'] }));
} finally { store?.close(); await rm(root, { recursive: true, force: true }); }

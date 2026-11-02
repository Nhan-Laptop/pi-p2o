import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AssessmentStore } from '../../src/state/store.js';
import { parseWorkspaceCommand } from '../../src/ui/workspace.js';
import { artifactSearchLines } from '../../src/ui/workspace.js';

async function fixture(work: (store: AssessmentStore) => void) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-artifact-index-'));
  const store = AssessmentStore.create(join(root, 'state'), { runId: 'run-artifact-index', retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture', targetDisplay: 'fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } });
  try { work(store); } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

const retain = (store: AssessmentStore, body: string, kind: string) =>
  store.ingestArtifact('owner', Buffer.from(body, 'utf8'), { kind, mediaType: 'application/json', totalBytes: Buffer.byteLength(body), maxBytes: Buffer.byteLength(body) });

describe('W-Y retained-artifact index', () => {
  it('searches retained artifacts by metadata only, newest first, and never by stored bytes', async () => {
    await fixture(store => {
      const first = retain(store, JSON.stringify({ entry: 'first' }), 'shell-stdout');
      const second = retain(store, JSON.stringify({ entry: 'second' }), 'traffic-snapshot');
      const third = retain(store, JSON.stringify({ entry: 'third', secretNeedle: 'unique-body-only' }), 'traffic-snapshot');
      const all = store.artifactSearch(undefined);
      expect(all.total).toBe(3);
      expect(all.rows.map(row => row.id)).toEqual([third.id, second.id, first.id]);
      // A kind/sha/receipt lookup is the index's job; body text is deliberately not a search field.
      expect(store.artifactSearch('traffic-snapshot').total).toBe(2);
      expect(store.artifactSearch(second.sha256.slice(0, 20)).rows.map(row => row.id)).toEqual([second.id]);
      expect(store.artifactSearch('unique-body-only').total).toBe(0);
      expect(store.artifactSearch('traffic', 1)).toMatchObject({ total: 2, shown: 1 });
      expect(store.artifactSearch('traffic', 1).rows[0].id).toBe(third.id);
      expect(() => store.artifactSearch('x'.repeat(121))).toThrow(/exceeds 120/);
      expect(() => store.artifactSearch('', 0)).toThrow(/1\.\.100/);
      expect(artifactSearchLines(store, 'traffic-snapshot').join('\n')).toContain('Metadata index only');
      expect(artifactSearchLines(store, 'traffic-snapshot').join('\n')).not.toContain('unique-body-only');
    });
  });

  it('parses /p2o artifacts as a metadata query without touching the by-id reader', () => {
    expect(parseWorkspaceCommand('artifacts traffic-snapshot')).toEqual({ action: 'artifacts', query: 'traffic-snapshot' });
    expect(parseWorkspaceCommand('artifacts ')).toEqual({ action: 'artifacts', query: '' });
    expect(() => parseWorkspaceCommand(`artifacts ${'x'.repeat(121)}`)).toThrow(/metadata only/);
    expect(parseWorkspaceCommand('artifact artifact-00000000-0000-0000-0000-000000000000 2048')).toMatchObject({ action: 'artifact', offset: 2048 });
  });
});

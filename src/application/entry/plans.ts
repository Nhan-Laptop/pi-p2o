/**
 * Durable entry-plan store.
 *
 * Plans, their sealed content digests and their once-only admissions live under the private entry control
 * root (0700 directories, 0600 files). `read` re-derives the sealed digest, so a mutated record is refused as
 * `ENTRY_PLAN_CORRUPT` instead of being approved. `markAdmitted` uses an exclusive create, so the same plan
 * can never launch twice even across processes.
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entryFail } from './errors.js';
import type { EntryPlanStore, StoredEntryPlan } from './types.js';

const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\.json$/;

interface AdmissionRecord { version: 1; planId: string; runId: string; at: string }

export function createEntryPlanStore(options: {
  root: string;
  clock?: () => number;
  /** Recompute the sealed digest of a record; a mismatch is refused as corrupt. */
  digestOf(record: StoredEntryPlan): string;
}): EntryPlanStore {
  if (!options.root || !options.root.startsWith('/')) entryFail('ENTRY_INTEGRATION_REQUIRED', 'entry control root must be a canonical absolute path');
  const controlRoot = options.root;
  const plansDir = join(controlRoot, 'plans');
  const admissionsDir = join(controlRoot, 'admissions');
  const clock = options.clock ?? Date.now;
  let prepared: Promise<void> | undefined;

  const ensure = async (): Promise<void> => {
    prepared ??= (async () => {
      await mkdir(controlRoot, { recursive: true, mode: 0o700 });
      await mkdir(plansDir, { recursive: true, mode: 0o700 });
      await mkdir(admissionsDir, { recursive: true, mode: 0o700 });
    })();
    await prepared;
  };

  const planPath = (planId: string): string => {
    if (!PLAN_ID.test(planId)) entryFail('ENTRY_FAILED', 'plan identity is not a bounded identifier');
    return join(plansDir, `${planId}.json`);
  };

  return Object.freeze({
    async save(record: StoredEntryPlan): Promise<void> {
      await ensure();
      const path = planPath(record.planId);
      const bytes = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(bytes) > MAX_PLAN_BYTES) entryFail('ENTRY_FAILED', 'plan record exceeds its byte bound');
      const temporary = `${path}.${process.pid}.${clock()}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, path);
    },

    async read(planId: string): Promise<StoredEntryPlan | null> {
      await ensure();
      let bytes: string;
      try { bytes = await readFile(planPath(planId), 'utf8'); }
      catch { return null; }
      if (Buffer.byteLength(bytes) > MAX_PLAN_BYTES) entryFail('ENTRY_PLAN_CORRUPT', 'stored plan exceeds its byte bound');
      let parsed: StoredEntryPlan;
      try { parsed = JSON.parse(bytes) as StoredEntryPlan; }
      catch { entryFail('ENTRY_PLAN_CORRUPT', 'stored plan is not valid JSON'); }
      if (!parsed || parsed.version !== 1 || parsed.planId !== planId
        || typeof parsed.preparation !== 'object' || parsed.preparation === null
        || typeof parsed.plan !== 'object' || parsed.plan === null) {
        entryFail('ENTRY_PLAN_CORRUPT', 'stored plan is not a version-1 entry plan');
      }
      const sealed = options.digestOf(parsed);
      if (sealed !== parsed.digest) entryFail('ENTRY_PLAN_CORRUPT', 'stored plan content no longer matches its sealed digest');
      return parsed;
    },

    async admitted(planId: string): Promise<{ runId: string } | null> {
      await ensure();
      try {
        const bytes = await readFile(join(admissionsDir, `${planId}.json`), 'utf8');
        const parsed = JSON.parse(bytes) as AdmissionRecord;
        if (!parsed || parsed.version !== 1 || parsed.planId !== planId || typeof parsed.runId !== 'string') {
          entryFail('ENTRY_PLAN_CORRUPT', 'stored admission is malformed');
        }
        return { runId: parsed.runId };
      } catch (error) {
        if (error instanceof Error && error.name === 'EntryError') throw error;
        return null;
      }
    },

    async markAdmitted(planId: string, runId: string): Promise<boolean> {
      await ensure();
      const record: AdmissionRecord = { version: 1, planId, runId, at: new Date(clock()).toISOString() };
      try {
        await writeFile(join(admissionsDir, `${planId}.json`), `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    },

    async runs(): Promise<Array<{ runId: string; planId: string; targetKind: StoredEntryPlan['preparation']['target']['kind']; startedAt: string }>> {
      await ensure();
      let names: string[];
      try { names = await readdir(admissionsDir); }
      catch { return []; }
      const byRun = new Map<string, { runId: string; planId: string; targetKind: StoredEntryPlan['preparation']['target']['kind']; startedAt: string }>();
      for (const name of names.sort().slice(0, 512)) {
        if (!FILE_NAME.test(name)) continue;
        const planId = name.slice(0, -5);
        let admission: AdmissionRecord;
        try { admission = JSON.parse(await readFile(join(admissionsDir, name), 'utf8')) as AdmissionRecord; }
        catch { continue; }
        if (!admission || admission.version !== 1 || typeof admission.runId !== 'string' || typeof admission.planId !== 'string') continue;
        const stored = await this.read(planId).catch(() => null);
        if (!stored) continue;
        byRun.set(admission.runId, {
          runId: admission.runId,
          planId,
          targetKind: stored.preparation.target.kind,
          startedAt: typeof admission.at === 'string' ? admission.at : new Date(clock()).toISOString(),
        });
      }
      return [...byRun.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    },
  } satisfies EntryPlanStore);
}

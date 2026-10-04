import { describe, it, expect } from 'vitest';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePackConsent, selectCapabilityPacks } from '../../src/application/onboarding/packs.js';
import { ContractUI } from './helpers.js';
import { fixture } from '../pack-readiness/helpers.js';
import { prepareCommandPacks } from '../../src/interface/onboarding.js';

describe('pack consent', () => {
  it('UI selection cancel performs no setup, check, save or grant', async () => {
    const f = await fixture();
    try {
      const ui = new ContractUI(); ui.cancelAt = 1;
      expect(await selectCapabilityPacks(ui, ['browser'])).toBeUndefined();
      ui.cancelAt = 2;
      const result = await prepareCommandPacks({ cwd: f.cwd, hasUI: true, ui, signal: new AbortController().signal }, f.owner, f.boundary, undefined, { storageRoot: f.storageRoot });
      expect(result.status).toBe('cancelled');
      expect((await readdir(f.base)).sort()).toEqual(['cwd', 'input', 'output']);
    } finally { await f.cleanup(); }
  });
  it('confirmation cancel saves nothing; headless new grant refuses', async () => {
    const f = await fixture();
    try {
      const ui = new ContractUI(); ui.cancelAt = 1;
      expect(await ensurePackConsent({ ...f, ui })).toEqual({ status: 'cancelled' });
      expect(await ensurePackConsent(f)).toEqual({ status: 'unsupported' });
      expect((await readdir(f.base)).sort()).toEqual(['cwd', 'input', 'output']);
    } finally { await f.cleanup(); }
  });
  it('owner-only persisted equal/narrow consent reuses headlessly; expansion and pin changes refuse', async () => {
    const f = await fixture();
    try {
      const original = await ensurePackConsent({ ...f, ui: new ContractUI() });
      expect(original.status).toBe('consented');
      const files = await readdir(f.storageRoot);
      expect((await stat(join(f.storageRoot, files[0]!))).mode & 0o777).toBe(0o600);
      const narrow = await ensurePackConsent({ ...f, selection: { ...f.selection, actions: ['read'], maxRequests: 2, maxCalls: 1 } });
      expect(narrow.status).toBe('consented');
      if (narrow.status === 'consented') { expect(narrow.reused).toBe(true); expect(narrow.consent.selection.maxRequests).toBe(2); }
      expect((await ensurePackConsent(f)).status).toBe('consented'); // wider original receipt survives
      expect((await ensurePackConsent({ ...f, selection: { ...f.selection, maxRequests: 11 } })).status).toBe('unsupported');
      await expect(ensurePackConsent({ ...f, selection: { ...f.selection, configurationDigest: 'a'.repeat(64) } })).rejects.toThrow('PACK_CONFIG_NOT_CONSENTED');
    } finally { await f.cleanup(); }
  });
  it('no mutation right through pack consent and no repository-provided callback data', async () => {
    const f = await fixture();
    try {
      await expect(ensurePackConsent({ ...f, selection: { ...f.selection, packs: ['browser'], actions: ['mutate'] }, ui: new ContractUI() })).rejects.toThrow('PACK_OWNER_BOUNDS');
      const saved = await ensurePackConsent({ ...f, ui: new ContractUI() }); expect(saved.status).toBe('consented');
      const name = (await readdir(f.storageRoot))[0]!;
      await writeFile(join(f.storageRoot, name), JSON.stringify({ source: 'model', selection: f.selection }));
      await expect(ensurePackConsent(f)).rejects.toThrow();
    } finally { await f.cleanup(); }
  });
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('K0 SQLite feasibility, not a runtime backend', () => {
  it('qualifies bounded local transaction/crash/read-only/full mechanics on the current Node only', async () => {
    const path=fileURLToPath(new URL('../../scripts/spike-assessment-store.mjs',import.meta.url));
    const {stdout}=await promisify(execFile)(process.execPath,[path],{timeout:20000});
    const receipt=JSON.parse(stdout);
    expect(receipt.node).toBe(process.version);
    expect(receipt.runtimeIntegrated).toBe(false);
    expect(receipt.mechanics).toHaveLength(6);
    expect(receipt.limitations).toContain('Node/Pi version matrix not implied');
  });
});

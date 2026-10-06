/** Owner-private informational accounting for native Pi turns, independent of worker gateway quotas. */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ForegroundUsageReceipt } from '../interface/types.js';

interface NativeUsage {
  basis: 'native-pi-message';
  qualification: string;
  messages: number;
  totals: ForegroundUsageReceipt['usage'];
  models: Array<{ provider: string; model: string }>;
  recentRecordIds: string[];
}
const name = 'foreground-usage.json';
export function readForegroundUsage(root: string): NativeUsage | undefined {
  const path = join(root, name);
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  if (bytes.length > 64 * 1024) throw new Error('Foreground usage journal exceeds its bound');
  const data = JSON.parse(bytes.toString('utf8')) as NativeUsage;
  if (data.basis !== 'native-pi-message' || !Number.isSafeInteger(data.messages) || !Array.isArray(data.models) || !Array.isArray(data.recentRecordIds) || !data.totals) throw new Error('Invalid foreground usage journal');
  return data;
}
export function recordForegroundUsage(root: string, receipt: ForegroundUsageReceipt): void {
  for (const [key, value] of Object.entries(receipt.usage)) {
    if (key === 'costUsd' && value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid native usage counter');
  }
  const data = readForegroundUsage(root) ?? { basis: 'native-pi-message',
    qualification: 'Provider-reported native Pi usage; informational, not gateway financial admission or assessment-worker attestation. Worker usage is reported separately.',
    messages: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 }, models: [], recentRecordIds: [] };
  if (data.recentRecordIds.includes(receipt.recordId)) return;
  data.messages++;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) data.totals[key] += receipt.usage[key];
  data.totals.costUsd = data.totals.costUsd === null || receipt.usage.costUsd === null ? null : data.totals.costUsd + receipt.usage.costUsd;
  if (!data.models.some(m => m.provider === receipt.provider && m.model === receipt.model)) data.models.push({ provider: receipt.provider, model: receipt.model });
  data.models = data.models.slice(0, 64);
  data.recentRecordIds = [...data.recentRecordIds, receipt.recordId].slice(-256);
  const temporary = join(root, `${name}.tmp`);
  writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
  renameSync(temporary, join(root, name));
}

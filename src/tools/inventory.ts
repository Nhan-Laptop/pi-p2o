import { checkCancelled, invariant } from '../policy/errors.js';
import type { HttpEvidence, HttpInput } from './types.js';

export interface InventoryEvidence { kind: 'inventory'; services: HttpEvidence[]; limits: string[] }
/** Explicit HTTP(S) endpoint inventory, not an ambient LAN/port scanner. */
export async function inventoryServices(urls: readonly string[], accountId: string, request: (input: HttpInput) => Promise<HttpEvidence>, signal?: AbortSignal): Promise<InventoryEvidence> {
  invariant(urls.length > 0 && urls.length <= 16 && new Set(urls).size === urls.length, 'INVALID_INPUT', 'Inventory requires a unique bounded endpoint list');
  const services: HttpEvidence[] = [];
  for (const url of urls) { checkCancelled(signal); services.push(await request({ url, accountId, method: 'HEAD' })); }
  return { kind: 'inventory', services, limits: ['Only explicitly supplied, approved HTTP(S) endpoints were observed.', 'No TCP/UDP scan, protocol guessing, banner exploitation or broad discovery.'] };
}

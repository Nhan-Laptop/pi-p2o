import { checkCancelled, invariant } from '../policy/errors.js';
/** Explicit HTTP(S) endpoint inventory, not an ambient LAN/port scanner. */
export async function inventoryServices(urls, accountId, request, signal) {
    invariant(urls.length > 0 && urls.length <= 16 && new Set(urls).size === urls.length, 'INVALID_INPUT', 'Inventory requires a unique bounded endpoint list');
    const services = [];
    for (const url of urls) {
        checkCancelled(signal);
        services.push(await request({ url, accountId, method: 'HEAD' }));
    }
    return { kind: 'inventory', services, limits: ['Only explicitly supplied, approved HTTP(S) endpoints were observed.', 'No TCP/UDP scan, protocol guessing, banner exploitation or broad discovery.'] };
}

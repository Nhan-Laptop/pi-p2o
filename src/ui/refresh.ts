/**
 * UI-only pacing for the progress widget's full-ledger scan. The scan is O(history); a fixed short window lets a long
 * run rescan continuously (about 0.7 s of synchronous work per refresh at 100k records on the K6 reference corpus).
 * The next scan waits the 25 ms coalescing window or four times the last measured scan, whichever is longer, capped at 5 s:
 * the widget may lag on very long histories but never drops data, and scan work stays near a fifth of wall time.
 * Pure: never reads state, notifies the Engine, calls a model or touches authority.
 */
export const UI_REFRESH_MIN_MS = 25;
export const UI_REFRESH_MAX_MS = 5000;
export const UI_REFRESH_COST_FACTOR = 4;

export function uiRefreshDelay(lastScanMs?: number): number {
  const cost = typeof lastScanMs === 'number' && Number.isFinite(lastScanMs) && lastScanMs > 0 ? lastScanMs : 0;
  return Math.min(UI_REFRESH_MAX_MS, Math.max(UI_REFRESH_MIN_MS, Math.ceil(UI_REFRESH_COST_FACTOR * cost)));
}

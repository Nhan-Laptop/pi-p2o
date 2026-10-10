import { describe, expect, it } from 'vitest';
import { UI_REFRESH_MAX_MS, UI_REFRESH_MIN_MS, uiRefreshDelay } from '../../src/ui/refresh.js';

describe('progress widget scan pacing (UI-only, pure)', () => {
  it('keeps the 25 ms coalescing window until a scan is measured or cheap', () => {
    expect(uiRefreshDelay()).toBe(UI_REFRESH_MIN_MS);
    expect(uiRefreshDelay(0)).toBe(25);
    expect(uiRefreshDelay(0.1)).toBe(25);
    expect(uiRefreshDelay(6)).toBe(25); // 4 x 6 ms is still inside the window
  });
  it('waits four times the last scan, capped at five seconds', () => {
    expect(uiRefreshDelay(12)).toBe(48);
    expect(uiRefreshDelay(57)).toBe(228); // measured 10k-record reference corpus
    expect(uiRefreshDelay(672)).toBe(2688); // measured 100k-record reference corpus
    expect(uiRefreshDelay(1250)).toBe(UI_REFRESH_MAX_MS);
    expect(uiRefreshDelay(60_000)).toBe(UI_REFRESH_MAX_MS);
  });
  it('treats malformed measurements as unmeasured: never a stall, a spin or a negative timer', () => {
    for (const bad of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5' as unknown as number, null as unknown as number]) {
      expect(uiRefreshDelay(bad)).toBe(UI_REFRESH_MIN_MS);
    }
  });
  it('is monotonic and always inside [25 ms, 5 s]', () => {
    let previous = 0;
    for (let ms = 0; ms <= 20_000; ms += 7) {
      const delay = uiRefreshDelay(ms);
      expect(delay).toBeGreaterThanOrEqual(UI_REFRESH_MIN_MS);
      expect(delay).toBeLessThanOrEqual(UI_REFRESH_MAX_MS);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });
});

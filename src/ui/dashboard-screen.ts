import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { DASHBOARD_SECTIONS, type DashboardSection } from './state.js';

const TAB_KEYS: Record<string, DashboardSection> = { 1: 'overview', 2: 'workers', 3: 'tasks', 4: 'coverage', 5: 'cases', 6: 'log' };

/**
 * Multi-tab live view over the same single-scan model /p2o status already builds (no second ledger scan). No
 * authority, IO or model calls; read-only navigation. `refresh()` is called by the owner run's existing refresh
 * pipeline when a new scan lands, so the screen stays current without polling or a timer of its own.
 */
export class DashboardScreen implements Component {
  private section: DashboardSection;
  private offset = 0;
  private lines: string[] = [];
  private width = -1;
  private dirty = true;
  private readonly pageSize = 17;
  constructor(private sectionLines: (section: DashboardSection) => string[], initialSection: DashboardSection, private close: () => void, private requestRender?: () => void) {
    this.section = initialSection;
  }
  /** Called by refreshVisibility after a new scan; re-renders live content without discarding the current tab/scroll position. */
  refresh() { this.dirty = true; this.requestRender?.(); }
  handleInput(data: string) {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || data === 'q') { this.close(); return; }
    if (data === 'r') { this.dirty = true; return; }
    const tab = TAB_KEYS[data];
    if (tab) { this.section = tab; this.offset = 0; this.dirty = true; return; }
    if (matchesKey(data, 'left')) { this.cycle(-1); return; }
    if (matchesKey(data, 'right')) { this.cycle(1); return; }
    const delta = matchesKey(data, 'down') ? 1 : matchesKey(data, 'up') ? -1 : matchesKey(data, 'pageDown') ? this.pageSize : matchesKey(data, 'pageUp') ? -this.pageSize : 0;
    this.offset = Math.max(0, Math.min(Math.max(0, this.lines.length - this.pageSize), this.offset + delta));
  }
  private cycle(direction: 1 | -1) {
    const i = DASHBOARD_SECTIONS.indexOf(this.section);
    this.section = DASHBOARD_SECTIONS[(i + direction + DASHBOARD_SECTIONS.length) % DASHBOARD_SECTIONS.length];
    this.offset = 0; this.dirty = true;
  }
  render(width: number): string[] {
    const available = Math.max(1, width);
    if (this.dirty || available !== this.width) {
      const tabs = DASHBOARD_SECTIONS.map((section, i) => section === this.section ? `[${i + 1}:${section}]` : ` ${i + 1}:${section} `).join(' ');
      this.lines = [tabs, ...this.sectionLines(this.section)].flatMap(line => wrapTextWithAnsi(line, available));
      this.width = available; this.dirty = false;
      this.offset = Math.min(this.offset, Math.max(0, this.lines.length - this.pageSize));
    }
    const page = this.lines.slice(this.offset, this.offset + this.pageSize);
    return [...page.map(line => truncateToWidth(line, available)),
      truncateToWidth(`←→/1-6 tabs · ↑↓ PgUp PgDn scroll · r refresh · Esc/q close (hold/stop-worker still work from the editor) · ${this.offset + (page.length ? 1 : 0)}–${this.offset + page.length}/${this.lines.length}`, available)];
  }
  invalidate() { this.width = -1; this.dirty = true; }
}

import { matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { cleanText } from '../process.js';
import { redact } from '../evidence.js';

/** No authority, IO or model calls. Reflow and bounded viewport handle narrow terminals. */
export class StateScreen implements Component {
  private offset = 0;
  private lines: string[] = [];
  private width = -1;
  private readonly pageSize = 18;
  constructor(private source: string[], private close: () => void) {}
  handleInput(data: string) {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || data === 'q') { this.close(); return; }
    const delta = matchesKey(data, 'down') ? 1 : matchesKey(data, 'up') ? -1 : matchesKey(data, 'pageDown') ? this.pageSize : matchesKey(data, 'pageUp') ? -this.pageSize : 0;
    this.offset = Math.max(0, Math.min(Math.max(0, this.lines.length - this.pageSize), this.offset + delta));
  }
  render(width: number): string[] {
    const available = Math.max(1, width);
    if (available !== this.width) {
      this.lines = this.source.flatMap(line => wrapTextWithAnsi(line, available));
      this.width = available;
      this.offset = Math.min(this.offset, Math.max(0, this.lines.length - this.pageSize));
    }
    const page = this.lines.slice(this.offset, this.offset + this.pageSize);
    return [...page.map(line => truncateToWidth(line, available)), truncateToWidth(`↑↓ / PgUp PgDn · ${this.offset + (page.length ? 1 : 0)}–${this.offset + page.length}/${this.lines.length} · Esc/q close`, available)];
  }
  invalidate() { this.width = -1; }
}

export function renderStateEntry(data: { action: string; runId: string; recordCount: number }): Text {
  const label = (value: unknown) => cleanText(redact(String(value))).replace(/\s+/g, ' ').slice(0, 100);
  return new Text(`p2o ${label(data.action)} · ${label(data.runId)} · records @${Number.isSafeInteger(data.recordCount) ? data.recordCount : 'unknown'}\nRead-only progress marker, not a checkpoint or execution authority.`, 0, 0);
}

export function widgetComponent(lines: string[]): Component {
  return { render: width => lines.map(line => truncateToWidth(line, Math.max(1, width))), invalidate() {} };
}

/** Small group renderer; expanded output is navigation data, never a verification badge. */
export function renderTaskResult(value: unknown, expanded: boolean): Text {
  const data = value as Record<string, unknown> | undefined;
  const rows = Array.isArray(data?.tasks) ? data.tasks as Array<Record<string, unknown>> : data?.id ? [data] : [];
  const text = rows.length ? rows.slice(0, expanded ? 25 : 5).map(row => `${row.id} · ${row.status === 'reported' ? 'awaiting owner review' : row.status} · ${String(row.question ?? '').slice(0, 250)}`).join('\n')
    : JSON.stringify(data ?? {}).slice(0, expanded ? 4000 : 600);
  return new Text(cleanText(redact(`${text}${!expanded && rows.length > 5 ? '\n… expand or query task ID for details' : ''}\nCoordination state; not proof of vulnerability or goal completion.`)), 0, 0);
}

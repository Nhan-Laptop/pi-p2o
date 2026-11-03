/**
 * planning_update.md P5a: the report tab is a viewer, not a renderer. These helpers read the exact REPORT.md text the snapshot
 * carried and return a bounded table of contents and display counts — never HTML, never a markdown conversion, never a clock.
 */
import { clamp } from './format';

export interface ReportHeading {
  /** ATX heading level, 1–6. */
  level: number;
  title: string;
  /** 1-based line number of the heading in the markdown text, so the viewer can scroll to that line's anchor. */
  line: number;
}

/** Opening fences are three or more backticks or tildes; an info string may follow, and a closer must use the same character. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** ATX headings require the space (or end of line) CommonMark asks for, so `#tag` and 7+ hashes stay prose. */
const ATX = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/;
const MAX_TITLE = 200;

/**
 * ATX headings outside fenced code blocks, in document order, bounded by `max` (default 200). A heading whose text is empty
 * after stripping a closing `###` sequence is not a navigation target, so it is skipped rather than rendered as a blank row.
 */
export function reportOutline(markdown: string, max = 200): ReportHeading[] {
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 200;
  if (limit === 0 || markdown.length === 0) return [];
  const headings: ReportHeading[] = [];
  const lines = markdown.split('\n');
  let fence: { marker: '`' | '~'; length: number } | null = null;
  for (let index = 0; index < lines.length && headings.length < limit; index += 1) {
    const line = lines[index]!;
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      // A closing fence repeats the opening character at least as many times and carries no info string.
      if (fenceMatch && fenceMatch[1]![0] === fence.marker && fenceMatch[1]!.length >= fence.length
        && line.slice(fenceMatch[0].length).trim() === '') fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0] as '`' | '~', length: fenceMatch[1]!.length };
      continue;
    }
    const heading = ATX.exec(line);
    if (!heading) continue;
    const title = (heading[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
    if (!title) continue;
    headings.push({ level: heading[1]!.length, title: clamp(title, MAX_TITLE), line: index + 1 });
  }
  return headings;
}

/** Display counts for the metadata strip; bytes are UTF-8 bytes (the same unit the host bound uses), not code units. */
export function reportStats(text: string): { lines: number; bytes: number; headings: number } {
  return {
    lines: text.length === 0 ? 0 : text.split('\n').length,
    bytes: new TextEncoder().encode(text).length,
    headings: reportOutline(text, Number.MAX_SAFE_INTEGER).length,
  };
}

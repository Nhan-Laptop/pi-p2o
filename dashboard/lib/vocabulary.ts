/**
 * planning_update.md P2: the graph vocabulary as the client renders it. The values mirror the committed projection
 * (`src/exploration-graph.ts`); `tests/minimal/dashboard-export.test.ts` compares the two lists, so a new node kind or
 * relation cannot go unlabelled in the UI without failing the root typecheck and the vocabulary test.
 */

/** Column bands, left to right, as the plan fixes them: guidance/start, goals, links and intents, facts and findings, digests. */
export const COLUMN_BANDS = ['guidance & start', 'goals', 'links & intents', 'facts & findings', 'digests'] as const;

export const KIND_ORDER = ['origin', 'hint', 'goal', 'link', 'intent', 'fact', 'finding', 'digest'] as const;

export const KIND_COLUMNS: Readonly<Record<string, number>> = {
  origin: 0, hint: 0, goal: 1, link: 2, intent: 2, fact: 3, finding: 3, digest: 4,
};

export const KIND_LABELS: Readonly<Record<string, string>> = {
  origin: 'start', goal: 'goal', link: 'chain link', intent: 'intent', fact: 'fact', finding: 'finding', hint: 'hint', digest: 'digest',
};

/** The closest stable glyph per kind: a mark, not an icon library (no external assets). */
export const KIND_GLYPHS: Readonly<Record<string, string>> = {
  origin: '▣', hint: '◆', goal: '◇', link: '⇢', intent: '▷', fact: '▪', finding: '▲', digest: '▤',
};

export const RELATION_ORDER = ['spawns', 'derived_from', 'yields', 'proves', 'leads_to', 'covers'] as const;

export interface RelationStyle { label: string; tone: string; description: string }
export const RELATION_STYLES: Readonly<Record<string, RelationStyle>> = {
  spawns: { label: 'spawns', tone: 'spawns', description: 'the record that created the next one' },
  derived_from: { label: 'derived from', tone: 'derived', description: 'a goal or intent derived from its parent' },
  yields: { label: 'yields', tone: 'yields', description: 'an intent that produced a fact' },
  proves: { label: 'proves', tone: 'proves', description: 'a fact or chain step that supports a goal' },
  leads_to: { label: 'leads to', tone: 'leads', description: 'recorded chain order' },
  covers: { label: 'covers', tone: 'covers', description: 'digest membership' },
};

export const kindColumn = (kind: string): number => KIND_COLUMNS[kind] ?? KIND_COLUMNS.digest!;
export const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind;
export const kindGlyph = (kind: string): string => KIND_GLYPHS[kind] ?? '•';
export const relationLabel = (rel: string): string => RELATION_STYLES[rel]?.label ?? rel;
export const relationTone = (rel: string): string => RELATION_STYLES[rel]?.tone ?? 'other';

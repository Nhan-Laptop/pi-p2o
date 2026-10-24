import { describe, expect, it } from 'vitest';
import { SEGMENT_FIELDS, situationLine, situationSegments, summarizeSituation, type SituationSnapshot } from '../../src/situation.js';
import { ownerInstructions, type OwnerPromptFacts } from '../../src/prompts.js';

/**
 * M9 (prompt/view parity). ARTEX's own drift bug is the model of this class: a prompt promised `sites_without_endpoints`, the view
 * stopped emitting it, and nothing failed (`my_references/ARTEX`, `agent/planner.go:309`). Here the chain is three-linked —
 * `summarizeSituation` produces the snapshot, `SEGMENT_FIELDS` declares which fields each segment reads, `situationSegments`
 * renders them, and `ownerInstructions` prints the line into the lead prompt. A field that is declared but never populated, a
 * segment that is never emitted, or a prompt that rewrites the line all have to fail this file.
 */
const base: SituationSnapshot = { open: 0, running: 0, runningRoles: [], ready: 0, exhausted: 0, leadsUntriaged: 0, leadsCritical: 0, routesOpen: 0, routesDone: 0, routeNames: [], unprovenNegations: 0, blocked: 0, openContradictions: 0,
  chainReady: 0, chainUnmet: 0, chainSteps: 0, chainReadySteps: 0, chainWaitingSteps: 0, pendingRating: 0, coverageTested: 0, coverageCells: 0, coveragePlanned: 0, coverageOmitted: 0, suggested: null };

/** One snapshot per declared segment: the smallest state in which that segment is the thing being said. */
const triggers: Record<keyof typeof SEGMENT_FIELDS, Partial<SituationSnapshot>> = {
  stall: { open: 0 },
  running: { open: 2, running: 1, runningRoles: ['discovery'] },
  ready: { open: 1, ready: 1 },
  next: { open: 1, ready: 1, suggested: { purpose: 'validation', score: 72 } },
  exhausted: { open: 1, exhausted: 1 },
  blocked: { open: 1, blocked: 1 },
  contradictions: { open: 0, openContradictions: 1 },
  chain: { open: 0, chainSteps: 2, chainReadySteps: 1, chainWaitingSteps: 1 },
  leads: { open: 0, leadsUntriaged: 2, leadsCritical: 1 },
  routes: { open: 0, routesOpen: 2, routesDone: 1, routeNames: ['auth'] },
  negation: { open: 0, unprovenNegations: 1 },
  rating: { open: 0, pendingRating: 1 },
  coverage: { open: 0, coverageTested: 3, coverageCells: 9, coveragePlanned: 4, coverageOmitted: 2 },
};

const ids = (snapshot: SituationSnapshot) => situationSegments(snapshot).map(segment => segment.id);

describe('situation parity: declared, produced and rendered stay one thing (M9)', () => {
  it('emits every declared segment for a state that has it', () => {
    for (const id of Object.keys(SEGMENT_FIELDS) as Array<keyof typeof SEGMENT_FIELDS>) {
      expect(ids({ ...base, ...triggers[id] }), `segment ${id} is declared but no state emits it`).toContain(id);
    }
  });

  it('emits nothing the map does not declare, and nothing without its own trigger', () => {
    // A quiet frontier says "0 open" and nothing else; an open one always states its ready count (P3).
    expect(ids({ ...base, open: 0 })).toEqual(['stall']);
    expect(ids({ ...base, open: 1 })).toEqual(['ready']);
    for (const id of Object.keys(triggers) as Array<keyof typeof triggers>) {
      const emitted = ids({ ...base, ...triggers[id] });
      for (const segment of emitted) expect(SEGMENT_FIELDS).toHaveProperty(segment);
    }
  });

  it('produces every field the segment map declares, so no segment reads a value nobody computes', () => {
    const snapshot = summarizeSituation({ tasks: [], cases: [], coverage: [], claims: [] });
    for (const [segment, fields] of Object.entries(SEGMENT_FIELDS)) {
      for (const field of fields) {
        expect(Object.keys(snapshot), `segment ${segment} reads ${field}, which summarizeSituation does not produce`).toContain(field);
        expect(snapshot[field], `segment ${segment} reads ${field}, which is never populated`).not.toBeUndefined();
      }
    }
    // The line is still the closed sentence the prompt prints.
    expect(situationLine(snapshot)).toBe('Situation: 0 open.');
  });

  it('prints exactly the rendered line in the lead prompt, never a second count of its own', () => {
    const facts: OwnerPromptFacts = { runId: 'run-parity', targetKind: 'directory', targetLabel: '/target', sourceSkipped: 0,
      delegation: { enabled: false, maxWorkers: 1, maxDepth: 1 }, phase: 'active', loopMode: 'manual', executorMode: 'shared' };
    for (const trigger of Object.values(triggers)) {
      const snapshot = { ...base, ...trigger };
      const line = situationLine(snapshot);
      const text = ownerInstructions({ ...facts, situation: snapshot });
      expect(text).toContain(line);
      // One situation sentence only: a prompt that appended "open=…" would be a second view of the same state.
      expect(text.split('Situation: ').length - 1).toBe(1);
    }
  });
});

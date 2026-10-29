import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_TOOLS, reporterTools } from '../../src/tool-policy.js';
import { REVIEW_OUTCOMES } from '../../src/state/graph-tool.js';

/**
 * planning_update.md P20/D (D-P20-7): the teaching docs state what the code does, and no current doc claims a verb the run
 * does not have. §2.7 of the plan recorded three claims that contradicted the code — the review verb "settling a fact", the
 * reporter "reading" graph rows, and the finish preflight telling the model to revise or retire a coverage cell it has no
 * writer for. Each assertion below ties the doc sentence to the same fact the code exposes (the review outcome enum, the
 * reporter loadout, the preflight message map), so a doc edit or a loadout change cannot drift apart silently.
 *
 * Static where the claim itself is prose; the cell messages also have behavioral assertions in `coverage.test.ts`
 * (INTERRUPTED_CELL) and `finish-preflight.test.ts` (WSTG_APPLICABLE_UNPLANNED). Hermetic: file reads only.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const DOCS = ['README.md', 'HANDOFFS.md'];
/** Historical rows keep the verb names of the revision they describe; every current-facing doc must name a live verb. */
const HISTORICAL = new Set(['HISTORY.md', 'ACCEPTANCE_MATRIX.md']);

const read = (relative: string) => readFile(join(ROOT, relative), 'utf8');
const currentDocs = async (): Promise<string[]> => [
  ...DOCS,
  ...(await readdir(join(ROOT, 'docs'))).filter(name => name.endsWith('.md') && !HISTORICAL.has(name)).map(name => `docs/${name}`),
];

describe('P20/D documentation truth pass', () => {
  it('describes graph review as settling a hypothesis or promoting an inferred relation, never a fact', async () => {
    // The code's own vocabulary: the four outcomes exist, and each one means what the doc says it means.
    expect(REVIEW_OUTCOMES).toEqual(['supported', 'refuted', 'inconclusive', 'observed']);
    const knowledge = (await read('docs/KNOWLEDGE.md')).replace(/\s+/g, ' ');
    expect(knowledge).toContain('settles a **hypothesis**');
    expect(knowledge).toContain('promotes an **inferred relation** to an observed edge');
    expect(knowledge).toContain('an observed or configuration fact is not re-judged by review');
    // The retired claim: a generic "one retained row" that implied an observed fact could be settled.
    expect(knowledge).not.toContain('settles or promotes one retained row');
  });

  it('says the reporter reads the ledger, artifacts and skills, and records that it holds no graph read', async () => {
    // The loadout is the fact behind the sentence: a reporter that held p2o_graph could read rows directly.
    expect(reporterTools()).not.toContain('p2o_graph');
    expect(reporterTools()).not.toContain('p2o_graph_review');
    expect(reporterTools()).toEqual(['p2o_report', 'p2o_ledger', 'p2o_artifact', 'p2o_skill_list', 'p2o_skill_read', 'p2o_state']);
    const knowledge = (await read('docs/KNOWLEDGE.md')).replace(/\s+/g, ' ');
    expect(knowledge).toContain('read-only over the ledger, retained artifacts and skills');
    expect(knowledge).toContain('holds no graph read');
    expect(knowledge).not.toContain('the reporter reads only');
  });

  it('never tells the model to write a coverage cell, which no role can do', async () => {
    const preflight = await read('src/finish-preflight.ts');
    // Retired cell-directed instructions: the model has no cell writer, so following them is impossible.
    for (const retired of ['revise or retire it', 'finish it or mark blocked with a gap', 'add a cell, or retire the plan', 'retire it with the reason']) {
      expect(preflight, `finish-preflight still says "${retired}"`).not.toContain(retired);
    }
    // The replacement directs the reviewed work the cell projects from and names the host derivation.
    for (const message of [
      'the host derives cells from reviewed work, so revise or re-review the task/claim it projects from',
      'the cell follows its reviewed task: finish or block that task; a cell has no model-facing writer',
      'plan and review a task whose question key is the test id',
      're-dispatch the task, or record why the cell stays open; the cell itself is host-derived',
    ]) expect(preflight, message).toContain(message);
  });

  it('keeps every p2o_ verb named by a current-facing doc on the model surface (D-P20-7)', async () => {
    const tools = new Set(MODEL_TOOLS);
    const missing: string[] = [];
    for (const file of await currentDocs()) {
      const text = await read(file);
      for (const token of new Set(text.match(/\bp2o_[a-z_]+\b/g) ?? [])) if (!tools.has(token)) missing.push(`${file}: ${token}`);
    }
    expect(missing, 'a current doc names a verb the model cannot call').toEqual([]);
    // The two renamed legacy verbs stay out of current prose as well; only HISTORY keeps the historical names. They are
    // assembled rather than written out so `surface-audit.test.ts` can keep grepping this directory for them.
    for (const retired of [['p2o', 'plan', 'author'].join('_'), ['p2o', 'coverage', 'suggest'].join('_')]) {
      for (const file of await currentDocs()) expect(await read(file), `${file}: ${retired}`).not.toContain(retired);
    }
  });
});

/**
 * planning_update.md P13(f): the prompt ceilings were the same numbers written by hand in three test files
 * (`recon.test.ts`, `measure-context.test.ts`, `workflow-policy.test.ts`), so every prompt change required three coordinated edits and
 * one of them was applied with a substitution that damaged a history comment. One table now owns the numbers; the tests read it.
 *
 * Rules for editing this file, in the spirit of the surrounding pins:
 * - Raise a number here on purpose, with a dated comment naming the change that grew the prompt. Never raise one to make a test pass.
 * - `lead` ceilings are counts of characters. `declaration` and `guidance` are serialized bytes summed over a loadout's tools.
 * - The budget test keeps a 2 % tolerance on declarations and guidance; these values are the measured size, not the tolerance.
 */
export const LEAD_CEILINGS = {
  /**
   * 2026-10-22 (planning_update.md P10): the lead's DELEGATION block gained one sentence per terminal state (done / exhausted /
   * blocked / stopped), because "hit the allowance" was being read as "answered". Static bodies grew to 5,611 (directory) /
   * 5,762 (url) / 6,579 (hybrid); every ceiling below is static + the 240-character situation allowance.
   */
  soloDirectory: 5900,
  soloUrl: 6050,
  hybridSolo: 6900,
  delegatedDirectory: 6550,
  delegatedUrl: 6700,
  delegatedEventDriven: 6950,
} as const;

/** Serialized tool declarations and prompt guidelines per loadout, measured 2026-10-22 (P7 moved the delegate description +52 B). */
export const DECLARATION_BUDGET = {
  'delegated Planner': [34_717, 1_162],
  'solo owner': [35_518, 1_080],
  'worker': [19_349, 473],
  'reporting worker': [12_477, 376],
} as const;

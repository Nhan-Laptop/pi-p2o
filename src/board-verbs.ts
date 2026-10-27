import { Type } from 'typebox';
import { choices } from './schema-kit.js';
import { CASE_REVIEW_STATUSES } from './case-types.js';
import { PLAN_KINDS } from './planning.js';
import { THINKING_LEVELS } from './roles.js';
import { taskDraftSchema } from './tool-schemas.js';
import { caseEntrySchema, coveragePlanSchema, findingSchema } from './case-tool.js';
import { planEntrySchema } from './work-tool.js';

/**
 * L1/W2: the four owner board bags are split into one verb per decision. Action bags made the model choose an action
 * before it could read the shape, and every stale revision had to be narrated in prose. These schemas are closed per verb;
 * the handler still delegates to the retained action implementation, so validation and stored bytes do not change.
 */
const id = () => Type.String({ minLength: 1, maxLength: 80 });
const requestId = () => Type.Optional(id());
const evidenceIds = () => Type.Optional(Type.Array(Type.String({ maxLength: 80 })));

export const TASK_VERB_ACTIONS = {
  p2o_task_create: 'create',
  p2o_task_revise: 'revise',
  p2o_task_start: 'start',
  p2o_task_dispatch: 'dispatch',
  p2o_task_review: 'review',
} as const;
export const TASK_SETTLE_ACTIONS = { closed: 'close', blocked: 'block', cancelled: 'cancel' } as const;
export const CASE_VERB_ACTIONS = {
  p2o_case_create: 'create',
  p2o_case_revise: 'revise',
  p2o_case_rate: 'rate',
} as const;
/** A3: cells are host-derived, so the coverage bag keeps one read-only verb and the plan write verb. */
export const COVERAGE_FIXED_ACTIONS = {
  p2o_coverage_suggest: 'suggest',
} as const;
export const PLAN_VERB_ACTIONS = {
  p2o_plan_create: 'create',
  p2o_plan_revise: 'revise',
} as const;

/** Old action -> new verb. `null` is deliberately removed: `p2o_board` is the only list/view reader, and a task match now
 * happens inside `p2o_task_create` itself, which returns the match payload instead of creating when an exact attempt exists. */
export const BOARD_ACTION_VERBS: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  p2o_task: {
    create: 'p2o_task_create', revise: 'p2o_task_revise', match: null, dispatch: 'p2o_task_dispatch',
    review: 'p2o_task_review', close: 'p2o_task_settle', block: 'p2o_task_settle', cancel: 'p2o_task_settle',
    list: 'p2o_board', start: 'p2o_task_start',
  },
  p2o_case: { create: 'p2o_case_create', revise: 'p2o_case_revise', rate: 'p2o_case_rate', list: 'p2o_board', view: 'p2o_board' },
  p2o_coverage: {
    'plan-create': 'p2o_coverage_plan', 'plan-revise': 'p2o_coverage_plan', suggest: 'p2o_coverage_suggest',
    'cell-create': null, 'cell-revise': null, 'cell-retire': null, list: 'p2o_board', view: 'p2o_board',
  },
  p2o_plan: { create: 'p2o_plan_create', revise: 'p2o_plan_revise', list: 'p2o_board', view: 'p2o_board' },
};

export const TASK_VERB_NAMES = [...Object.keys(TASK_VERB_ACTIONS), 'p2o_task_settle'] as const;
export const CASE_VERB_NAMES = Object.keys(CASE_VERB_ACTIONS) as Array<keyof typeof CASE_VERB_ACTIONS>;
export const COVERAGE_VERB_NAMES = ['p2o_coverage_plan', ...Object.keys(COVERAGE_FIXED_ACTIONS)] as const;
export const PLAN_VERB_NAMES = Object.keys(PLAN_VERB_ACTIONS) as Array<keyof typeof PLAN_VERB_ACTIONS>;
export const BOARD_VERB_NAMES = [...TASK_VERB_NAMES, ...CASE_VERB_NAMES, ...COVERAGE_VERB_NAMES, ...PLAN_VERB_NAMES, 'p2o_board'] as const;
export const BOARD_TOOL = 'p2o_board';
export const BOARD_NAMES = ['tasks', 'cases', 'coverage', 'plans'] as const;

export const taskCreateParameters = Type.Object({ draft: taskDraftSchema }, { additionalProperties: false });
export const taskReviseParameters = Type.Object({ draft: taskDraftSchema, id: id(), revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const taskStartParameters = Type.Object({ id: id() }, { additionalProperties: false });
export const taskDispatchParameters = Type.Object({
  ids: Type.Optional(Type.Array(id(), { minItems: 1, maxItems: 25 })), id: Type.Optional(id()), priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  /** A7.5/D19: dispatch the successor onto a held worker's ticket, pane and session instead of paying for a new one. */
  workerId: Type.Optional(Type.String({ minLength: 3, maxLength: 64, description: 'A held worker to continue with this task: same ticket, pane and session; the task must cite that worker\'s own demonstrated claim in work.claimRefs' })),
  // P10/WF-02/03 (Q28): one-dispatch runtime override on top of the task draft's runtime. The host validates both against the
  // configured model set and thinking levels; a held ticket keeps the runtime it was started with.
  model: Type.Optional(Type.String({ maxLength: 200, description: 'Worker model for this dispatch; must be one of the configured role models (overrides the task draft runtime for this dispatch)' })),
  thinking: Type.Optional(choices(THINKING_LEVELS)),
}, { additionalProperties: false });
export const taskReviewParameters = Type.Object({
  id: id(), revision: Type.Integer({ minimum: 1 }), reason: Type.Optional(Type.String({ minLength: 5, maxLength: 1000 })),
  evidenceIds: evidenceIds(), externalEvidence: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export const taskSettleParameters = Type.Object({
  outcome: choices(['closed', 'blocked', 'cancelled']), id: id(), revision: Type.Integer({ minimum: 1 }),
  reason: Type.Optional(Type.String({ minLength: 5, maxLength: 1000 })), evidenceIds: evidenceIds(), externalEvidence: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const caseCreateParameters = Type.Object({ entry: caseEntrySchema, requestId: requestId() }, { additionalProperties: false });
export const caseReviseParameters = Type.Object({ entry: caseEntrySchema, id: id(), revision: Type.Integer({ minimum: 1 }), requestId: requestId() }, { additionalProperties: false });
export const caseRateParameters = Type.Object({ finding: findingSchema, id: id(), revision: Type.Integer({ minimum: 1 }), requestId: requestId() }, { additionalProperties: false });

export const coveragePlanParameters = Type.Object({
  plan: coveragePlanSchema, id: Type.Optional(id()), revision: Type.Optional(Type.Integer({ minimum: 1 })), requestId: requestId(),
}, { additionalProperties: false });
export const coverageSuggestParameters = Type.Object({
  features: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 20 })),
  modes: Type.Optional(Type.String({ maxLength: 5 })), cursor: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, { additionalProperties: false });

export const planCreateParameters = Type.Object({ entry: planEntrySchema, requestId: requestId() }, { additionalProperties: false });
export const planReviseParameters = Type.Object({ entry: planEntrySchema, id: id(), revision: Type.Integer({ minimum: 1 }), requestId: requestId() }, { additionalProperties: false });

export const boardParameters = Type.Object({
  board: choices(BOARD_NAMES), id: Type.Optional(id()), cursor: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), status: Type.Optional(choices(CASE_REVIEW_STATUSES)),
  kind: Type.Optional(choices(PLAN_KINDS)),
}, { additionalProperties: false });

/** Plan authoring selects create vs revise by the presence of the identity, never by a second `action` field. */
export const planAuthoringAction = (params: { id?: string }): 'plan-create' | 'plan-revise' => params.id ? 'plan-revise' : 'plan-create';
export const settleAction = (outcome: keyof typeof TASK_SETTLE_ACTIONS): 'close' | 'block' | 'cancel' => TASK_SETTLE_ACTIONS[outcome];
export const boardReadAction = (idValue?: string): 'list' | 'view' => idValue ? 'view' : 'list';

/** A stale revision refusal must say what the caller can do next with the revision the host actually holds. */
export const LEGAL_NEXT: Readonly<Record<string, string>> = {
  task: 'p2o_task_revise (same id, revision=<currentRevision>)',
  case: 'p2o_case_revise or p2o_case_rate (same id, revision=<currentRevision>)',
  coveragePlan: 'p2o_coverage_plan (id=<id>, revision=<currentRevision>)',
  plan: 'p2o_plan_revise (id=<id>, revision=<currentRevision>)',
};

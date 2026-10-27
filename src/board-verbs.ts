import { Type } from 'typebox';
import { choices } from './schema-kit.js';
import { CASE_REVIEW_STATUSES } from './case-types.js';
import { PLAN_KINDS } from './planning.js';
import { THINKING_LEVELS } from './roles.js';
import { taskDraftSchema } from './tool-schemas.js';
import { caseEntrySchema, coveragePlanSchema, findingSchema } from './case-tool.js';
import { planEntrySchema } from './work-tool.js';

/**
 * L1/W2: the four owner board bags are split into one verb per decision, and each create/revise pair is one authoring verb.
 * Action bags made the model choose an action before it could read the shape; a pair made it read two near-identical
 * schemas and pick the right name for the same write. An authoring verb follows `p2o_coverage_plan`: no id creates,
 * id+revision revises, and the identity is enough to pick the action. The handler still delegates to the retained action
 * implementation, so validation and stored bytes do not change.
 */
const id = () => Type.String({ minLength: 1, maxLength: 80 });
const requestId = () => Type.Optional(id());
const evidenceIds = () => Type.Optional(Type.Array(Type.String({ maxLength: 80 })));
const revision = () => Type.Optional(Type.Integer({ minimum: 1 }));

/** The three merged authoring verbs, named once so the role loadout, the schemas and the refusals cannot drift apart. */
export const AUTHORING_VERBS = { task: 'p2o_task_author', case: 'p2o_case_author', plan: 'p2o_plan_author' } as const;
export type AuthoringKind = keyof typeof AUTHORING_VERBS;
const AUTHORING_BOARDS: Readonly<Record<AuthoringKind, string>> = { task: 'tasks', case: 'cases', plan: 'plans' };
export const TASK_SETTLE_ACTIONS = { closed: 'close', blocked: 'block', cancelled: 'cancel' } as const;
/** A3: cells are host-derived, so the coverage bag keeps one read-only verb and the plan write verb. */
export const COVERAGE_FIXED_ACTIONS = {
  p2o_coverage_suggest: 'suggest',
} as const;

/** Old action -> new verb. `null` is deliberately removed: `p2o_board` is the only list/view reader, and a task match now
 * happens inside `p2o_task_author` itself, which returns the match payload instead of creating when an exact attempt exists.
 * Both halves of an authoring pair name the same verb, because the action comes from the identity in the parameters. */
export const BOARD_ACTION_VERBS: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  p2o_task: {
    create: 'p2o_task_author', revise: 'p2o_task_author', match: null, dispatch: 'p2o_task_dispatch',
    review: 'p2o_task_review', close: 'p2o_task_settle', block: 'p2o_task_settle', cancel: 'p2o_task_settle',
    list: 'p2o_board', start: 'p2o_task_start',
  },
  p2o_case: { create: 'p2o_case_author', revise: 'p2o_case_author', rate: 'p2o_case_rate', list: 'p2o_board', view: 'p2o_board' },
  p2o_coverage: {
    'plan-create': 'p2o_coverage_plan', 'plan-revise': 'p2o_coverage_plan', suggest: 'p2o_coverage_suggest',
    'cell-create': null, 'cell-revise': null, 'cell-retire': null, list: 'p2o_board', view: 'p2o_board',
  },
  p2o_plan: { create: 'p2o_plan_author', revise: 'p2o_plan_author', list: 'p2o_board', view: 'p2o_board' },
};

export const TASK_VERB_NAMES = [AUTHORING_VERBS.task, 'p2o_task_start', 'p2o_task_dispatch', 'p2o_task_review', 'p2o_task_settle'] as const;
export const CASE_VERB_NAMES = [AUTHORING_VERBS.case, 'p2o_case_rate'] as const;
export const COVERAGE_VERB_NAMES = ['p2o_coverage_plan', ...Object.keys(COVERAGE_FIXED_ACTIONS)] as const;
export const PLAN_VERB_NAMES = [AUTHORING_VERBS.plan] as const;
export const BOARD_VERB_NAMES = [...TASK_VERB_NAMES, ...CASE_VERB_NAMES, ...COVERAGE_VERB_NAMES, ...PLAN_VERB_NAMES, 'p2o_board'] as const;
export const BOARD_TOOL = 'p2o_board';
export const BOARD_NAMES = ['tasks', 'cases', 'coverage', 'plans'] as const;

/**
 * The authoring pair convention: no id creates, id+revision revises. Deriving the action here means a half identity is refused
 * before a handler runs, with the verb and the revision the caller can actually use.
 */
export function authoringAction(kind: AuthoringKind, params: { id?: string; revision?: number; action?: unknown }): 'create' | 'revise' {
  const verb = AUTHORING_VERBS[kind];
  if (params.action !== undefined) throw Error(`INVALID_INPUT: ${verb} derives create/revise from the identity; action is host-owned and cannot be supplied.`);
  if (params.id === undefined) {
    if (params.revision !== undefined) throw Error(`INVALID_INPUT: ${verb} got revision=${params.revision} without an id. A revision changes an existing ${kind}: pass id=<${kind} id> with revision=<currentRevision>, or omit revision to create a new ${kind}.`);
    return 'create';
  }
  if (!Number.isSafeInteger(params.revision) || (params.revision as number) < 1) throw Error(`INVALID_INPUT: ${verb} got id=${params.id} without a usable revision. Read the current revision with p2o_board board=${AUTHORING_BOARDS[kind]} id=${params.id}, then call ${verb} (same id, revision=<currentRevision>); omit id to create a new ${kind} instead.`);
  return 'revise';
}

export const taskAuthorParameters = Type.Object({ draft: taskDraftSchema, id: Type.Optional(id()), revision: revision() }, { additionalProperties: false });
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

export const caseAuthorParameters = Type.Object({ entry: caseEntrySchema, id: Type.Optional(id()), revision: revision(), requestId: requestId() }, { additionalProperties: false });
export const caseRateParameters = Type.Object({ finding: findingSchema, id: id(), revision: Type.Integer({ minimum: 1 }), requestId: requestId() }, { additionalProperties: false });

export const coveragePlanParameters = Type.Object({
  plan: coveragePlanSchema, id: Type.Optional(id()), revision: Type.Optional(Type.Integer({ minimum: 1 })), requestId: requestId(),
}, { additionalProperties: false });
export const coverageSuggestParameters = Type.Object({
  features: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 20 })),
  modes: Type.Optional(Type.String({ maxLength: 5 })), cursor: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, { additionalProperties: false });

export const planAuthorParameters = Type.Object({ entry: planEntrySchema, id: Type.Optional(id()), revision: revision(), requestId: requestId() }, { additionalProperties: false });

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
  task: 'p2o_task_author (same id, revision=<currentRevision>)',
  case: 'p2o_case_author or p2o_case_rate (same id, revision=<currentRevision>)',
  coveragePlan: 'p2o_coverage_plan (id=<id>, revision=<currentRevision>)',
  plan: 'p2o_plan_author (id=<id>, revision=<currentRevision>)',
};

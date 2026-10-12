import { Type } from 'typebox';
import { choices } from './schema-kit.js';
import { KNOWLEDGE_DOMAINS } from './context.js';
import { COVERAGE_OUTCOMES } from './records.js';
import { MAX_SKILLS, ROLES, THINKING_LEVELS } from './roles.js';
import { WORKER_OUTCOMES } from './broker.js';
import { CANDIDATE_CLOSURES, CANDIDATE_EXECUTIONS, CANDIDATE_PROOFS, POLICY_BASES } from './evidence.js';
import { HTTP_METHOD_PATTERN } from './target.js';
import { outputContractSchema, workDecisionSchema, workSpecSchema } from './work-tool.js';

/**
 * Parameter schemas of the model-facing tools. They are the declaration payload sent on every turn, so the byte sizes are pinned by
 * tests/minimal/workflow-policy.test.ts; the plan, case, coverage and graph tools keep theirs beside their validators (*-tool.ts).
 */
export const stateParameters = Type.Object({action:choices(['heads', 'search']),q:Type.Optional(Type.String({minLength:2,maxLength:80})),domain:Type.Optional(choices(KNOWLEDGE_DOMAINS)),status:Type.Optional(Type.String({maxLength:80})),cursor:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},{additionalProperties:false});

export const taskDraftSchema = Type.Object({
    question:Type.String({minLength:1,maxLength:1500}),surface:Type.String({minLength:1,maxLength:200}),risk:Type.String({minLength:1,maxLength:200}),
    // Required for every role except recon, which may omit them for a lighter intent (src/tasks.ts validate() enforces the role-conditional minimum).
    role:choices(ROLES),roleReason:Type.Optional(Type.String({maxLength:1000})),
    expectedTrue:Type.Optional(Type.String({maxLength:1000})),expectedFalse:Type.Optional(Type.String({maxLength:1000})),stopCondition:Type.Optional(Type.String({maxLength:1000})),
    expectedOutput:Type.Optional(Type.String({minLength:5,maxLength:1000})),
    unknowns:Type.Optional(Type.Array(Type.String({minLength:10,maxLength:500}),{maxItems:10})),missingPrerequisites:Type.Optional(Type.Array(Type.String({minLength:10,maxLength:500}),{maxItems:10})),
    evidenceIds:Type.Array(Type.String({maxLength:80}),{maxItems:10}),prerequisites:Type.Array(Type.Object({taskId:Type.String({maxLength:80}),revision:Type.Optional(Type.Integer({minimum:1}))}),{maxItems:10}),
    validationOf:Type.Optional(Type.String({maxLength:80})),retestOf:Type.Optional(Type.String({maxLength:80})),parentTaskId:Type.Optional(Type.String({maxLength:80})),
    work:Type.Optional(workSpecSchema),decision:Type.Optional(workDecisionSchema),outputContract:Type.Optional(outputContractSchema),
    skills:Type.Optional(Type.Array(Type.String({maxLength:64}),{maxItems:3})),workflow:Type.Optional(Type.String({maxLength:64})),methodReason:Type.Optional(Type.String({maxLength:1000})),
  },{additionalProperties:false});

export const TASK_ACTIONS = ['create','revise','match','list','start','review','close','block','cancel','dispatch'] as const;
export const taskParameters = Type.Object({action:choices(TASK_ACTIONS),
      id:Type.Optional(Type.String({maxLength:80})),revision:Type.Optional(Type.Integer({minimum:1})),draft:Type.Optional(taskDraftSchema),
      ids:Type.Optional(Type.Array(Type.String({maxLength:80}),{minItems:1,maxItems:25})),priority:Type.Optional(Type.Integer({minimum:0,maximum:100})),
      cursor:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:25})),
      reason:Type.Optional(Type.String({minLength:5,maxLength:1000})),evidenceIds:Type.Optional(Type.Array(Type.String({maxLength:80}),{maxItems:10})),externalEvidence:Type.Optional(Type.Boolean())});

export const surfaceParameters = Type.Object({component:Type.String({minLength:1,maxLength:200}),entryPoint:Type.String({minLength:1,maxLength:200}),text:Type.Optional(Type.String({maxLength:1000})),refs:Type.Optional(Type.Array(Type.String({maxLength:80}),{maxItems:10}))},{additionalProperties:false});

export const skillListParameters = Type.Object({ query: Type.Optional(Type.String({ maxLength: 80 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) });

export const skillReadParameters = Type.Object({ id: Type.String({ maxLength: 160 }), offset: Type.Optional(Type.Integer({ minimum: 0 })) });

export const candidateParameters = Type.Object({
      candidate: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,79}$' }), surface: Type.String({ minLength: 1, maxLength: 200 }), risk: Type.String({ minLength: 1, maxLength: 200 }),
      closure: choices(CANDIDATE_CLOSURES),
      execution: choices(CANDIDATE_EXECUTIONS),
      proof: choices(CANDIDATE_PROOFS),
      evidenceRefs: Type.Array(Type.String({ maxLength: 80 }), { maxItems: 10, description: 'Owner-generated Evidence ID UUIDs from tool results, not invented labels or probe cell names' }),
      negativeControls: Type.Array(Type.String({ maxLength: 80 }), { maxItems: 10, description: 'Evidence ID UUIDs of commands containing the negative-control observations; describe individual control cells in limitations, not in this ID array' }),
      policyBasis: choices(POLICY_BASES),
      expectedPolicy: Type.String({ minLength: 1, maxLength: 1000, description: 'State the violated intended policy/invariant and its provenance; a sibling route difference alone is only inferred' }),
      limitations: Type.String({ minLength: 1, maxLength: 1500 }), control: Type.Optional(Type.String({ maxLength: 1000 })),
      resolves: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 10 })),
      requirement: Type.Optional(Type.String({ minLength: 10, maxLength: 1000, description: 'For blocked execution, describe the actual scope restriction, missing binary/dependency or failed prerequisite; not a capability ID' })), supersedes: Type.Optional(Type.String({ maxLength: 80 })), independentEvidenceRef: Type.Optional(Type.String({ maxLength: 80 })),
    });

export const captureParameters = Type.Object({path:Type.String({minLength:1,maxLength:2048}),offset:Type.Optional(Type.Integer({minimum:0})),timeout:Type.Optional(Type.Integer({minimum:0}))});

export const execParameters = Type.Object({ command: Type.String({ minLength: 1, maxLength: 8192 }), timeout: Type.Optional(Type.Integer({ minimum: 0, description: 'Optional seconds; 0 or omitted means no task timeout' })) });

export const httpParameters = Type.Object({
      url: Type.String({ minLength: 1, maxLength: 4096 }),
      method: Type.Optional(Type.String({ minLength: 1, maxLength: 32, pattern: HTTP_METHOD_PATTERN })),
      headers: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 4096 }), { maxProperties: 20 })),
      body: Type.Optional(Type.String({ maxLength: 32768 })),
      followRedirects: Type.Optional(Type.Boolean()),
      maxRedirects: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
      session: Type.Optional(Type.String({ minLength: 1, maxLength: 40, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$' })),
      resetSession: Type.Optional(Type.Boolean()),
      timeout: Type.Optional(Type.Integer({minimum:0,description:'Optional per-hop seconds; 0 or omitted disables the task timeout'})),
      connectTimeout: Type.Optional(Type.Integer({minimum:0,description:'Optional connect seconds; 0 or omitted uses underlying network/library defaults'})),
    });

export const noteParameters = Type.Object({
      kind: choices(['note', 'coverage', 'observation', 'open']),
      text: Type.String({ minLength: 1, maxLength: 2000 }),
      surface: Type.Optional(Type.String({ maxLength: 200 })),
      risk: Type.Optional(Type.String({ maxLength: 200 })),
      outcome: Type.Optional(choices(COVERAGE_OUTCOMES)),
      refs: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 10 })),
    });

export const artifactParameters = Type.Object({id:Type.String({minLength:45,maxLength:45,pattern:'^artifact-[a-f0-9-]{36}$'}),offset:Type.Optional(Type.Integer({minimum:0})),length:Type.Optional(Type.Integer({minimum:1,maximum:8192}))});

export const ledgerParameters = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), id: Type.Optional(Type.String({ maxLength: 80 })), cursor: Type.Optional(Type.Integer({ minimum:0 })) });

export const delegateParameters = Type.Object({
      focus: Type.String({ minLength: 3, maxLength: 60, description: 'Short label, e.g. "idor-checkout"' }),
      task: Type.String({ minLength: 1, maxLength: 4000, description: 'The objective: what to test/verify, success criteria and stop conditions' }),
      context: Type.Optional(Type.String({ maxLength: 4000, description: 'Background the worker must not re-derive: known facts, covered surfaces, record ids' })),
      role: Type.Optional(choices(ROLES)),
      skills: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: MAX_SKILLS })),
      model: Type.Optional(Type.String({ maxLength: 200 })),
      workflow: Type.Optional(Type.String({ maxLength: 64, description: 'Optional catalog workflow ID belonging to the selected skills; descriptive prerequisites do not grant permissions' })),
      thinking: Type.Optional(choices(THINKING_LEVELS)),
      taskId:Type.Optional(Type.String({maxLength:80,description:'Owner-authored proposed task ID; prerequisites and reservations are checked. Worker requests cannot dispatch owner task IDs.'})),
      work:Type.Optional(Type.Object({},{additionalProperties:true,description:'Optional structured work identity exactly as in p2o_task create (with decision and outputContract); enables exact duplicate/history checks. Omitted: identity is unknown.'})),
      decision:Type.Optional(Type.Object({},{additionalProperties:true})),outputContract:Type.Optional(Type.Object({},{additionalProperties:true})),
    });

export const subtaskParameters = Type.Object({focus:Type.String({minLength:3,maxLength:60}),task:Type.String({minLength:1,maxLength:4000}),context:Type.Optional(Type.String({maxLength:4000})),role:Type.Optional(choices(ROLES))});

export const loopParameters = Type.Object({action:choices(['status','wait','blocked']),reason:Type.Optional(Type.String({minLength:1,maxLength:1000}))});

export const workersParameters = Type.Object({
      waitFor: Type.Optional(choices(['change', 'all-report'])),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 300 })),
      cursor:Type.Optional(Type.Integer({minimum:0,description:'Prior ledger cursor for a bounded change page'})),
    });

export const steerParameters = Type.Object({ workerId: Type.String({ minLength: 1, maxLength: 64 }), message: Type.String({ minLength: 1, maxLength: 2000 }) });

export const stopWorkerParameters = Type.Object({ workerId: Type.String({ minLength: 1, maxLength: 64 }), reason: Type.String({ minLength: 1, maxLength: 300 }) });

export const reportParameters = Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
      findings: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 })),
      evidence: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 40 })),
      coverage: Type.Optional(Type.Array(Type.Object({ surface: Type.String({ maxLength: 200 }), risk: Type.String({ maxLength: 200 }), outcome: choices(COVERAGE_OUTCOMES) }), { maxItems: 40 })),
      openItems: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 })),
      confidence: choices(['high', 'medium', 'low']),
      blocked: Type.Optional(Type.String({ maxLength: 1000 })),
      outcome:Type.Optional(choices(WORKER_OUTCOMES)),
    });

export const finishParameters = Type.Object({ narrative: Type.Optional(Type.String({ maxLength: 6000 })) });

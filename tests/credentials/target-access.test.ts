// T2 deliverable 2: authenticated target access.
//
// Accounts/capability grants resolve credential material from the credential-owning boundary at
// dispatch time, never from worker input or workspace files. Missing/expired/unknown/mis-bound
// credentials deny with an explicit code and no request is issued. Offline loopback fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertCredentialIdentity, controllerInstant, createCredentialAuthority, type OwnerCredentialStore,
} from "../../src/application/authority.js";
import { CredentialDeniedError, credentialRef } from "../../src/policy/targets.js";
import { createSupervisorBackend, type CredentialAvailabilityPort, type CredentialRequirement, type SupervisorPort } from "../../src/interface/supervisor-backend.js";
import { InterfaceError, type RunMode } from "../../src/interface/types.js";
import { openStore, type DurableStore } from "../../src/store/index.js";
import type { RunManifest } from "../../src/contracts/index.js";
import {
  ACCOUNT_A, ACCOUNT_B, ACCOUNT_EXPIRES, ACCOUNT_MISSING, AT, TARGET_ID_A, TARGET_ID_B,
  TARGET_SECRET_A, TARGET_SECRET_B, RecordingCredentialStore, approvedAccount, assertNoCredentialForm,
  decisionFor, httpPost, prepareDirs, runManifestFor, startTarget, tempRoot, webTarget,
} from "./helpers.js";

const ACCOUNT_VALID_UNTIL = "2026-10-02T12:00:00.000Z";

test("authenticated target access: per-account credentials resolve only from the owner boundary at dispatch", async (t) => {
  const root = await tempRoot("p2o-t2-target-");
  const { workspace } = await prepareDirs(root);
  const target = await startTarget();
  t.after(async () => { await target.close(); await rm(root, { recursive: true, force: true }); });

  const store = new RecordingCredentialStore([
    { accountId: ACCOUNT_A, version: "v1", secret: TARGET_SECRET_A, expiresAt: ACCOUNT_EXPIRES, targetIds: [TARGET_ID_A], actions: ["read"] },
    { accountId: ACCOUNT_B, version: "v2", secret: TARGET_SECRET_B, expiresAt: ACCOUNT_EXPIRES, targetIds: [TARGET_ID_B], actions: ["read"] },
  ]);
  const authority = createCredentialAuthority({ store });
  const port: CredentialAvailabilityPort = authority; // structural contract consumed by the interface layer
  assert.deepEqual(
    await port.availability({ accountId: ACCOUNT_A, targetId: TARGET_ID_A, action: "read", at: AT }),
    { ok: true, identity: { accountId: ACCOUNT_A, version: "v1", ref: credentialRef(ACCOUNT_A, "v1", TARGET_SECRET_A), expiresAt: ACCOUNT_EXPIRES } },
  );
  assert.equal(controllerInstant(() => Date.parse(AT)), AT);

  const targetA = webTarget(TARGET_ID_A, [ACCOUNT_A]);
  const targetB = webTarget(TARGET_ID_B, [ACCOUNT_B]);
  const accountA = approvedAccount(ACCOUNT_A, [TARGET_ID_A], ["read"], ACCOUNT_EXPIRES);
  const approvedA = decisionFor(accountA, targetA);

  // Positive path: the approved account's secret is injected at dispatch; one request is issued.
  const credential = await authority.resolveAtDispatch(approvedA, AT);
  assert.equal(credential.accountId, ACCOUNT_A);
  assert.equal(credential.version, "v1");
  assert.equal(credential.expiresAt, ACCOUNT_EXPIRES);
  assert.equal(credential.ref, credentialRef(ACCOUNT_A, "v1", TARGET_SECRET_A));
  assert.equal(JSON.stringify(credential).includes(TARGET_SECRET_A), false, "the serializable identity must not carry the secret");
  assert.deepEqual(credential.headers(), { authorization: `Bearer ${TARGET_SECRET_A}` });
  assert.equal(assertCredentialIdentity(credential).ref, credential.ref);
  assert.throws(() => assertCredentialIdentity({ ...credential, ref: "plaintext-ref" }), CredentialDeniedError);
  const ok = await httpPost(`${target.origin}/probe`, "{}", credential.headers());
  assert.equal(ok.status, 200);
  assert.equal(target.requests.length, 1);
  assert.equal(target.requests[0]!.authorization, `Bearer ${TARGET_SECRET_A}`);

  const issued = target.requests.length;
  const deny = async (run: () => Promise<unknown>, code: string): Promise<void> => {
    const error = await run().then(() => undefined, (reason: unknown) => reason);
    assert.ok(error instanceof CredentialDeniedError, `expected CredentialDeniedError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(target.requests.length, issued, `denial ${code} must not issue a request`);
  };

  const targetAWithMissing = webTarget(TARGET_ID_A, [ACCOUNT_A, ACCOUNT_MISSING]);
  await deny(() => authority.resolveAtDispatch(decisionFor(approvedAccount(ACCOUNT_MISSING, [TARGET_ID_A], ["read"], ACCOUNT_EXPIRES), targetAWithMissing), AT), "CREDENTIAL_MISSING");
  await deny(() => authority.resolveAtDispatch(decisionFor(approvedAccount(ACCOUNT_A, [TARGET_ID_A], ["read"], AT), targetA), AT), "CREDENTIAL_EXPIRED");
  await deny(() => authority.resolveAtDispatch(decisionFor(accountA, targetB), AT), "CREDENTIAL_TARGET_MISMATCH");
  await deny(() => authority.resolveAtDispatch(decisionFor(accountA, targetA, "mutate"), AT), "CREDENTIAL_ACTION_DENIED");
  await deny(() => authority.resolveAtDispatch(decisionFor(approvedAccount("../../etc/passwd", [TARGET_ID_A], ["read"], ACCOUNT_EXPIRES), targetA), AT), "CREDENTIAL_UNKNOWN");
  assert.equal(store.reads.includes("../../etc/passwd"), false, "malformed account ids must never reach the owner store");

  // Expired owner material denies even while the policy approval is still valid.
  const expiredAuthority = createCredentialAuthority({ store: new RecordingCredentialStore([
    { accountId: ACCOUNT_A, version: "v1", secret: TARGET_SECRET_A, expiresAt: AT, targetIds: [TARGET_ID_A] },
  ]) });
  await deny(() => expiredAuthority.resolveAtDispatch(decisionFor(approvedAccount(ACCOUNT_A, [TARGET_ID_A], ["read"], ACCOUNT_VALID_UNTIL), targetA), ACCOUNT_EXPIRES), "CREDENTIAL_EXPIRED");

  // A mis-keyed owner store returns another account's material: deny, never serve it.
  const misKeyed: OwnerCredentialStore = {
    read: async () => ({ accountId: ACCOUNT_B, version: "v1", secret: TARGET_SECRET_B, expiresAt: ACCOUNT_EXPIRES, targetIds: [TARGET_ID_A] }),
    list: async () => [ACCOUNT_A],
  };
  await deny(() => createCredentialAuthority({ store: misKeyed }).resolveAtDispatch(approvedA, AT), "CREDENTIAL_UNKNOWN");

  // A worker can never select another account: extra worker-supplied fields are ignored, only the
  // approved policy decision's account is read, and account B's secret is never used for account A.
  const forged = { ...approvedA, accountId: ACCOUNT_B, credentialId: "provider-main", apiKey: TARGET_SECRET_B } as typeof approvedA & Record<string, unknown>;
  const readsBefore = store.reads.length;
  const resolvedForged = await authority.resolveAtDispatch(forged, AT);
  assert.equal(resolvedForged.accountId, ACCOUNT_A);
  assert.deepEqual(store.reads.slice(readsBefore), [ACCOUNT_A]);
  assert.equal(resolvedForged.headers().authorization, `Bearer ${TARGET_SECRET_A}`);

  // A workspace file carrying another account's secret has no effect on resolution.
  await writeFile(path.join(workspace, "credentials.json"), JSON.stringify({ accountId: ACCOUNT_B, secret: TARGET_SECRET_B }));
  const resolvedFromWorkspace = await authority.resolveAtDispatch(approvedA, AT);
  assert.equal(resolvedFromWorkspace.headers().authorization, `Bearer ${TARGET_SECRET_A}`);
  await httpPost(`${target.origin}/probe`, "{}", resolvedFromWorkspace.headers());
  assert.equal(target.requests.at(-1)!.authorization, `Bearer ${TARGET_SECRET_A}`);

  const described = JSON.stringify({ resolved: resolvedFromWorkspace, reads: store.reads });
  assertNoCredentialForm(described, TARGET_SECRET_A);
  assert.equal(described.includes(TARGET_SECRET_B), false, "account B's secret must never appear for an account A dispatch");
});

class FakeSupervisor implements SupervisorPort {
  readonly calls: string[] = [];
  constructor(private readonly store: DurableStore) {}
  admitRun(input: { manifest: RunManifest; mode: RunMode }): unknown {
    this.calls.push("admitRun");
    this.store.createRun(input.manifest);
    return { admitted: true };
  }
  start(runId: string): unknown { this.calls.push(`start:${runId}`); return { runId }; }
  cancel(runId: string): unknown { this.calls.push(`cancel:${runId}`); return { schedulingStopped: true, terminationVerified: true, failures: [] }; }
  recover(runId: string): unknown { this.calls.push(`recover:${runId}`); return {}; }
  snapshot(runId: string): unknown { this.calls.push(`snapshot:${runId}`); return { runId }; }
  preflight(): { issues: never[]; warnings: never[] } { return { issues: [], warnings: [] }; }
}

interface BackendHarness { store: DurableStore; supervisor: FakeSupervisor; backend: ReturnType<typeof createSupervisorBackend>; manifestPath: string }

async function backendHarness(root: string, input: { runId: string; now: () => number; credentials?: CredentialAvailabilityPort; plan?: CredentialRequirement[] }): Promise<BackendHarness> {
  const store = openStore({ path: path.join(root, `${input.runId}.sqlite`) });
  const supervisor = new FakeSupervisor(store);
  const backend = createSupervisorBackend({
    store, supervisor, now: input.now, closeStore: false,
    render: (runId, format) => ({ runId, format }),
    credentials: input.credentials, credentialPlan: input.plan,
  });
  const manifestPath = path.join(root, `${input.runId}.json`);
  await writeFile(manifestPath, JSON.stringify(runManifestFor(input.runId)));
  return { store, supervisor, backend, manifestPath };
}

test("interface backend: credential denials block readiness and every dispatch (no admit/start)", async (t) => {
  const root = await tempRoot("p2o-t2-backend-");
  const stores: DurableStore[] = [];
  t.after(async () => { for (const store of stores) { try { store.close(); } catch { /* already closed */ } } await rm(root, { recursive: true, force: true }); });
  await mkdir(root, { recursive: true });

  const store = new RecordingCredentialStore([
    { accountId: ACCOUNT_A, version: "v1", secret: TARGET_SECRET_A, expiresAt: "2026-10-02T10:30:00.000Z", targetIds: [TARGET_ID_A] },
  ]);
  const authority = createCredentialAuthority({ store });
  const plan: CredentialRequirement[] = [{ accountId: ACCOUNT_A, targetId: TARGET_ID_A, action: "read" }];
  let clock = Date.parse(AT); // credential expires 10:30; the run window is 09:00-12:00
  const harness = await backendHarness(root, { runId: "t2-run-ok", now: () => clock, credentials: authority, plan });
  stores.push(harness.store);

  const preflight = await harness.backend.preflight({ manifestPath: harness.manifestPath, mode: "fixture" });
  assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
  assert.deepEqual(store.reads, [ACCOUNT_A], "the owner-supplied plan is the only credential source");
  assertNoCredentialForm(JSON.stringify(preflight), TARGET_SECRET_A);

  // Expiry between readiness and dispatch: start must re-resolve and deny before any supervisor call.
  clock = Date.parse("2026-10-02T10:31:00.000Z");
  const expired = await harness.backend.start({ manifestPath: harness.manifestPath, mode: "fixture" }).then(() => undefined, (reason: unknown) => reason);
  assert.ok(expired instanceof InterfaceError, `expected InterfaceError, got ${String(expired)}`);
  assert.equal(expired.code, "CREDENTIAL_EXPIRED");
  assert.deepEqual(harness.supervisor.calls, []);
  assertNoCredentialForm(expired.message, TARGET_SECRET_A);

  // Missing owner material: explicit DENY at readiness and at dispatch.
  const missing = await backendHarness(root, { runId: "t2-run-missing", now: () => Date.parse(AT), credentials: authority, plan: [{ accountId: ACCOUNT_MISSING, targetId: TARGET_ID_A, action: "read" }] });
  stores.push(missing.store);
  const missingPreflight = await missing.backend.preflight({ manifestPath: missing.manifestPath, mode: "fixture" });
  assert.equal(missingPreflight.ok, false);
  assert.ok(missingPreflight.issues.some((issue) => issue.code === "CREDENTIAL_MISSING"));
  const missingError = await missing.backend.start({ manifestPath: missing.manifestPath, mode: "fixture" }).then(() => undefined, (reason: unknown) => reason);
  assert.ok(missingError instanceof InterfaceError);
  assert.equal(missingError.code, "CREDENTIAL_MISSING");
  assert.deepEqual(missing.supervisor.calls, []);

  // No owner boundary wired with a non-empty plan: fail closed, never dispatch unauthenticated.
  const unwired = await backendHarness(root, { runId: "t2-run-unwired", now: () => Date.parse(AT), plan });
  stores.push(unwired.store);
  const unwiredPreflight = await unwired.backend.preflight({ manifestPath: unwired.manifestPath, mode: "fixture" });
  assert.equal(unwiredPreflight.ok, false);
  assert.ok(unwiredPreflight.issues.some((issue) => issue.code === "CREDENTIAL_BOUNDARY_UNAVAILABLE"));
  const unwiredError = await unwired.backend.start({ manifestPath: unwired.manifestPath, mode: "fixture" }).then(() => undefined, (reason: unknown) => reason);
  assert.ok(unwiredError instanceof InterfaceError);
  assert.equal(unwiredError.code, "CREDENTIAL_BOUNDARY_UNAVAILABLE");
  assert.deepEqual(unwired.supervisor.calls, []);
});

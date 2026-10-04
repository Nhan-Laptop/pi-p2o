// T2 deliverable 1: controller-owned model credential gateway, worker placeholder isolation,
// attested provider/model/thinking, deny-before-upstream paths, credential redaction and the
// worker-side receipt guard. Offline: loopback fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GATEWAY_PLACEHOLDER, GATEWAY_PLACEHOLDER_PATTERN, auditArtifactsForSecrets, controllerGatewayRuntime,
  createControllerModelGateway, credentialDigestRef, redactCredentialText, validateConfiguration, workerConfig,
} from "../../src/runtime/config.js";
import { createEvidenceRedactor } from "../../src/evidence/redaction.js";
import { credentialRef } from "../../src/policy/targets.js";
import guard from "../../src/runtime/pi-receipts.js";
import { atomicJson, readJson } from "../../src/runtime/io.js";
import type { ModelGateway, WorkerConfig } from "../../src/runtime/types.js";
import {
  MODEL, MODEL_ENTRY, PROVIDER, REAL_PROVIDER_SECRET, SECOND_PROVIDER_SECRET, SELECTION,
  assertNoCredentialForm, httpPost, prepareDirs, readTree, runtimeHandleFor, runtimeOptionsFor,
  runtimeRequestFor, startUpstream, tempRoot,
} from "./helpers.js";

const APPROVAL = "t2-test-only-owner-approved-credential-gateway";

function gatewayOptions(upstreamOrigin: string, overrides: Partial<Parameters<typeof createControllerModelGateway>[0]> = {}) {
  return {
    approval: APPROVAL, provider: PROVIDER, upstreamBaseUrl: upstreamOrigin, api: "openai-completions" as const,
    models: [MODEL_ENTRY], credential: { accountId: "provider-main", version: "2026-10-03", secret: REAL_PROVIDER_SECRET },
    ...overrides,
  };
}

test("controller model gateway: worker sees only an isolated placeholder; upstream receives the real secret", async (t) => {
  const root = await tempRoot("p2o-t2-gateway-");
  const { controlRoot, controlDir, workspace } = await prepareDirs(root);
  const upstream = await startUpstream();
  const logLines: string[] = [];
  const gateway = createControllerModelGateway(gatewayOptions(upstream.origin, { log: (line) => logLines.push(line) }));
  await gateway.listen();
  t.after(async () => { await gateway.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); });

  const options = runtimeOptionsFor(controlRoot, gateway.gateway);
  await validateConfiguration(options, runtimeRequestFor(workspace));
  assert.equal(controllerGatewayRuntime(gateway.gateway), gateway, "bound gateway view must be registered for the runtime");

  const handle = runtimeHandleFor(controlDir, workspace);
  const config = await workerConfig(handle, options, false);
  const agentDir = path.join(controlDir, "home", ".pi", "agent");
  const models = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8")) as { providers: Record<string, { baseUrl: string; apiKey: string }> };
  const provider = models.providers[PROVIDER]!;
  assert.throws(() => gateway.bindAttempt({ attemptId: handle.attemptId, requested: SELECTION }), /policy\/receipt identity cannot change/);
  const placeholder = gateway.bindAttempt({ attemptId: handle.attemptId, requested: SELECTION, receiptFile: path.join(controlDir, 'gateway-attestation.json') });
  assert.equal(provider.apiKey, placeholder);
  assert.match(provider.apiKey, GATEWAY_PLACEHOLDER_PATTERN);
  assert.notEqual(provider.apiKey, GATEWAY_PLACEHOLDER);
  assert.equal(provider.baseUrl, gateway.url);
  assert.match(gateway.url, /^http:\/\/127\.0\.0\.1:\d+\/p2o-gw\/[0-9a-f]{8}$/);

  // Placeholder-only worker surface: env, argv and the serialized worker config.
  assert.equal(Object.keys(config.env).some((name) => /key|secret|token|password/i.test(name)), false);
  for (const [name, value] of Object.entries(config.env)) {
    assertNoCredentialForm(value, REAL_PROVIDER_SECRET);
    assert.equal(/sk-[A-Za-z0-9_-]{16,}/.test(value), false, `worker env ${name} is credential-shaped`);
  }
  assert.equal(config.args.join(" ").includes(REAL_PROVIDER_SECRET), false);
  assertNoCredentialForm(JSON.stringify(config), REAL_PROVIDER_SECRET);

  // One real exchange through the loopback gateway.
  const exchange = await httpPost(`${gateway.url}/chat/completions`, JSON.stringify({ model: MODEL, reasoning_effort: "max-effort", stream: true, messages: [] }), { authorization: `Bearer ${placeholder}`, "content-type": "application/json" });
  assert.equal(exchange.status, 200);
  assert.match(exchange.body, /\[DONE\]/);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0]!.authorization, `Bearer ${REAL_PROVIDER_SECRET}`);
  assert.equal(upstream.requests[0]!.path, "/chat/completions");

  const attestations = gateway.attestations();
  const forwarded = attestations.at(-1)!;
  assert.equal(forwarded.outcome, "forwarded");
  assert.equal(forwarded.attemptId, "attempt-1");
  assert.deepEqual(forwarded.observed, { provider: PROVIDER, model: MODEL, thinking: "max", thinkingValue: "max-effort" });
  assert.equal(forwarded.matchesRequest, true);
  assert.equal(forwarded.credential.accountId, "provider-main");
  assert.equal(forwarded.credential.version, "2026-10-03");
  assert.equal(forwarded.credential.ref, credentialDigestRef("provider-main", "2026-10-03", REAL_PROVIDER_SECRET));
  assert.match(forwarded.request.digest, /^[a-f0-9]{64}$/);
  assert.equal(forwarded.upstream?.origin, upstream.origin);

  // Receipt, logs and attestations: digest reference only, never the secret or the placeholder capability.
  const receipt = await readFile(path.join(controlDir, "gateway-attestation.json"), "utf8");
  const configTree = await readTree(controlDir);
  const emitted = [configTree, receipt, gateway.logLines().join("\n"), logLines.join("\n"), JSON.stringify(attestations)].join("\n");
  assertNoCredentialForm(emitted, REAL_PROVIDER_SECRET);
  assert.ok(configTree.includes(placeholder), "the worker's isolated catalog carries exactly the minted placeholder");
  const receiptsAndLogs = [receipt, gateway.logLines().join("\n"), logLines.join("\n"), JSON.stringify(attestations)].join("\n");
  assert.equal(receiptsAndLogs.includes(placeholder), false, "attestation/log artifacts must not carry the placeholder capability");
  assert.ok(receiptsAndLogs.includes(forwarded.credential.ref));
  assert.ok(await gateway.assertNoSecrets(controlDir) >= 3);

  // Negative control: the artifact audit detects raw and base64 credential material.
  const planted = path.join(root, "planted");
  await mkdir(planted);
  await writeFile(path.join(planted, "leak.env"), `PROVIDER_KEY=${REAL_PROVIDER_SECRET}\n`);
  await assert.rejects(() => auditArtifactsForSecrets(planted, [REAL_PROVIDER_SECRET]), /Credential material detected/);
  await writeFile(path.join(planted, "leak.env"), Buffer.from(REAL_PROVIDER_SECRET).toString("base64"));
  await assert.rejects(() => auditArtifactsForSecrets(planted, [REAL_PROVIDER_SECRET]), /Credential material detected/);
});

test("controller model gateway: auth/model/thinking/route/expiry denials issue no upstream request", async (t) => {
  const root = await tempRoot("p2o-t2-gateway-deny-");
  const { controlRoot, workspace } = await prepareDirs(root);
  const upstream = await startUpstream();
  let clock = Date.parse("2026-10-03T00:00:00.000Z");
  const gateway = createControllerModelGateway(gatewayOptions(upstream.origin, {
    now: () => clock,
    credential: { accountId: "provider-main", version: "2026-10-03", secret: REAL_PROVIDER_SECRET, expiresAt: "2026-10-03T01:00:00.000Z" },
  }));
  await gateway.listen();
  t.after(async () => { await gateway.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); });

  const options = runtimeOptionsFor(controlRoot, gateway.gateway);
  const request = runtimeRequestFor(workspace);
  const placeholder = gateway.bindAttempt({ attemptId: "attempt-deny", requested: SELECTION });
  await validateConfiguration(options, request);

  const forged = `p2o-gw.v1.${"0".repeat(8)}.${"1".repeat(32)}`;
  const unauthorized = await httpPost(`${gateway.url}/chat/completions`, JSON.stringify({ model: MODEL }), { authorization: `Bearer ${forged}` });
  assert.equal(unauthorized.status, 401);
  assert.equal((JSON.parse(unauthorized.body) as { error: { code: string } }).error.code, "GATEWAY_AUTH_DENIED");

  const badModel = await httpPost(`${gateway.url}/chat/completions`, JSON.stringify({ model: "not-provisioned" }), { authorization: `Bearer ${placeholder}` });
  assert.equal(badModel.status, 403);
  assert.equal((JSON.parse(badModel.body) as { error: { code: string } }).error.code, "GATEWAY_MODEL_DENIED");

  const badThinking = await httpPost(`${gateway.url}/chat/completions`, JSON.stringify({ model: MODEL, reasoning_effort: "off-effort" }), { authorization: `Bearer ${placeholder}` });
  assert.equal(badThinking.status, 403);
  assert.equal((JSON.parse(badThinking.body) as { error: { code: string } }).error.code, "GATEWAY_THINKING_DENIED");

  const badRoute = await httpPost(`${gateway.url}/v1/models`, "{}", { authorization: `Bearer ${placeholder}` });
  assert.equal(badRoute.status, 404);
  assert.equal((JSON.parse(badRoute.body) as { error: { code: string } }).error.code, "GATEWAY_ENDPOINT_DENIED");

  assert.equal(upstream.requests.length, 0, "no denial path may issue an upstream request");

  // A placeholder minted while valid stops working once the owner credential expires.
  clock = Date.parse("2026-10-03T02:00:00.000Z");
  const expired = await httpPost(`${gateway.url}/chat/completions`, JSON.stringify({ model: MODEL, reasoning_effort: "max-effort" }), { authorization: `Bearer ${placeholder}` });
  assert.equal(expired.status, 503);
  assert.equal((JSON.parse(expired.body) as { error: { code: string } }).error.code, "GATEWAY_CREDENTIAL_EXPIRED");
  assert.equal(upstream.requests.length, 0);
  assert.equal(gateway.readiness(SELECTION).code, "GATEWAY_CREDENTIAL_EXPIRED");
  assert.throws(() => gateway.bindAttempt({ attemptId: "attempt-after-expiry", requested: SELECTION }), /not ready/);
  await assert.rejects(() => validateConfiguration(options, request), /GATEWAY_CREDENTIAL_EXPIRED|not ready/);

  const denied = gateway.attestations();
  assert.deepEqual(denied.map((entry) => entry.denial?.code),
    ["GATEWAY_AUTH_DENIED", "GATEWAY_MODEL_DENIED", "GATEWAY_THINKING_DENIED", "GATEWAY_ENDPOINT_DENIED", "GATEWAY_CREDENTIAL_EXPIRED"]);
  assert.equal(denied[2]!.observed.thinkingValue, "off-effort");
  assert.equal(denied[2]!.observed.thinking, "unknown");
  assert.equal(denied[1]!.observed.model, "not-provisioned");
  assert.equal(denied[0]!.attemptId, null);
  for (const entry of denied) assert.equal(JSON.stringify(entry).includes(REAL_PROVIDER_SECRET), false);
});

test("plain gateway configs: loopback-only enforcement and the legacy placeholder fallback", async (t) => {
  const root = await tempRoot("p2o-t2-plain-");
  const { controlRoot, controlDir, workspace } = await prepareDirs(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const plain: ModelGateway = { approval: "t2-plain-owner-approval", baseUrl: "http://127.0.0.1:1/never-contacted", api: "openai-completions", models: [{ id: MODEL, thinkingLevelMap: { max: "max-effort" } }] };
  assert.equal(controllerGatewayRuntime(plain), undefined);
  await workerConfig(runtimeHandleFor(controlDir, workspace), runtimeOptionsFor(controlRoot, plain), false);
  const models = JSON.parse(await readFile(path.join(controlDir, "home", ".pi", "agent", "models.json"), "utf8")) as { providers: Record<string, { apiKey: string }> };
  assert.equal(models.providers[PROVIDER]!.apiKey, GATEWAY_PLACEHOLDER);
  await assert.rejects(() => validateConfiguration(runtimeOptionsFor(controlRoot, { ...plain, baseUrl: "https://provider.example.invalid/v1" }), runtimeRequestFor(workspace)), /loopback/);
});

test("credential redaction: stable digest references and evidence-redactor reuse", () => {
  const ref = credentialDigestRef(REAL_PROVIDER_SECRET);
  assert.equal(ref, credentialRef(REAL_PROVIDER_SECRET)); // cross-module stability (runtime vs policy)
  assert.match(ref, /^sha256:[a-f0-9]{64}$/);
  assert.equal(ref, credentialDigestRef(REAL_PROVIDER_SECRET));
  assert.notEqual(ref, credentialDigestRef(SECOND_PROVIDER_SECRET));

  const bearer = redactCredentialText(`authorization: Bearer ${REAL_PROVIDER_SECRET}`, [REAL_PROVIDER_SECRET]);
  assert.equal(bearer, `authorization: ${ref}`);
  assert.equal(bearer, redactCredentialText(`authorization: Bearer ${REAL_PROVIDER_SECRET}`, [REAL_PROVIDER_SECRET]));
  assert.equal(createEvidenceRedactor([REAL_PROVIDER_SECRET]).text(bearer), bearer, "evidence redactor has nothing left to remove");

  const keyed = redactCredentialText(`api_key=${REAL_PROVIDER_SECRET}`, [REAL_PROVIDER_SECRET]);
  assert.equal(keyed, ref);
  assert.equal(createEvidenceRedactor([REAL_PROVIDER_SECRET]).text(keyed), keyed);

  const json = redactCredentialText(JSON.stringify({ apiKey: REAL_PROVIDER_SECRET }), [REAL_PROVIDER_SECRET]);
  assert.equal(json.includes(REAL_PROVIDER_SECRET), false);
  assert.ok(json.includes(ref));

  assert.equal(redactCredentialText(REAL_PROVIDER_SECRET, [REAL_PROVIDER_SECRET]), ref);
  assert.equal(redactCredentialText(encodeURIComponent(REAL_PROVIDER_SECRET), [REAL_PROVIDER_SECRET]), ref, "encoded form maps to the same reference");
  assert.equal(redactCredentialText(Buffer.from(REAL_PROVIDER_SECRET).toString("base64"), [REAL_PROVIDER_SECRET]), ref, "base64 form maps to the same reference");
  assert.equal(redactCredentialText("no credentials here", [REAL_PROVIDER_SECRET]), "no credentials here");
});

interface GuardContext {
  cwd: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  sessionManager: { getSessionFile(): string | undefined };
  isIdle(): boolean;
  shutdown(): void;
}
interface GuardApi {
  on(name: string, callback: (event: { text?: string; toolName?: string }, ctx: GuardContext) => unknown): void;
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string; sourceInfo: { source: string; path: string } }>;
}

async function runReceiptGuard(input: { controlDir: string; extraEnv?: Record<string, string>; models?: unknown }): Promise<{ ready: boolean; error?: string }> {
  const workspace = path.join(input.controlDir, "..", "workspace");
  const agentDir = path.join(input.controlDir, "home", ".pi", "agent");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  if (input.models !== undefined) await writeFile(path.join(agentDir, "models.json"), JSON.stringify(input.models));
  const config: WorkerConfig = {
    version: 1, token: "t2-token", controlDir: input.controlDir, workspace, deadlineAt: Date.now() + 60_000, stopGraceMs: 0,
    piBinary: process.execPath, args: [], env: {}, sessionFile: path.join(input.controlDir, "session.jsonl"),
    requested: { ...SELECTION }, toolPolicy: { mode: "trusted-fixture", allowUnsandboxedHostTools: true, tools: [] },
    receiptFile: path.join(input.controlDir, "pi-receipt.json"), journalFile: path.join(input.controlDir, "guardian.json"),
  };
  const configPath = path.join(input.controlDir, "worker.json");
  const saved = { ...process.env };
  const handlers = new Map<string, (event: { text?: string; toolName?: string }, ctx: GuardContext) => unknown>();
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.P2O_CONFIG = configPath;
    process.env.P2O_ISOLATED = config.token;
    Object.assign(process.env, input.extraEnv ?? {});
    config.env = { ...process.env } as Record<string, string>;
    config.env.PI_CODING_AGENT_DIR = agentDir;
    await atomicJson(configPath, config);
    (guard as unknown as (api: GuardApi) => void)({
      on: (name, callback) => { handlers.set(name, callback); }, getActiveTools: () => [], getAllTools: () => [],
    });
    const ctx: GuardContext = {
      cwd: workspace, model: { provider: PROVIDER, id: MODEL }, thinkingLevel: "max",
      sessionManager: { getSessionFile: () => config.sessionFile }, isIdle: () => true, shutdown: () => {},
    };
    handlers.get("session_start")!({}, ctx);
    return (await readJson<{ ready: boolean; error?: string }>(config.receiptFile, 10_000)) ?? { ready: false, error: "no receipt" };
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("worker receipt guard: credential-shaped env / catalog values fail closed, placeholder passes", async (t) => {
  const root = await tempRoot("p2o-t2-receipt-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const placeholder = `p2o-gw.v1.deadbeef.${"a".repeat(32)}`;
  const loopbackBase = "http://127.0.0.1:41234/p2o-gw/deadbeef";

  const envCase = await runReceiptGuard({ controlDir: path.join(root, "env"), extraEnv: { T2_TEST_PROVIDER_KEY: REAL_PROVIDER_SECRET } });
  assert.equal(envCase.ready, false);
  assert.match(envCase.error ?? "", /Credential-shaped environment value is present: T2_TEST_PROVIDER_KEY/);
  assertNoCredentialForm(await readFile(path.join(root, "env", "pi-receipt.json"), "utf8"), REAL_PROVIDER_SECRET);

  const catalogCase = await runReceiptGuard({ controlDir: path.join(root, "catalog"), models: { providers: { [PROVIDER]: { baseUrl: loopbackBase, apiKey: REAL_PROVIDER_SECRET, models: [] } } } });
  assert.equal(catalogCase.ready, false);
  assert.match(catalogCase.error ?? "", /not a controller-minted placeholder/);

  const remoteCase = await runReceiptGuard({ controlDir: path.join(root, "remote"), models: { providers: { [PROVIDER]: { baseUrl: "https://api.provider.invalid/v1", apiKey: placeholder, models: [] } } } });
  assert.equal(remoteCase.ready, false);
  assert.match(remoteCase.error ?? "", /loopback/);

  const okCase = await runReceiptGuard({ controlDir: path.join(root, "ok"), models: { providers: { [PROVIDER]: { baseUrl: loopbackBase, apiKey: placeholder, models: [] } } } });
  assert.equal(okCase.ready, true);
  assert.equal(okCase.error, undefined);
});

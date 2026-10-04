// Shared offline fixtures for the T2 credential-handling suite.
//
// Every server binds 127.0.0.1 only and no non-loopback host is contacted. Nothing here reads or
// writes a real provider/target credential: the sentinels below exist purely so the suite can grep
// for their absence in emitted artifacts.
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ManagedRuntimeOptions, RuntimeHandle, RuntimeRequest, RuntimeSelection, Thinking } from "../../src/runtime/types.js";
import type { Action, ApprovedAccount, CapabilityGrant, Decision, WebTarget } from "../../src/policy/types.js";
import type { OwnerCredentialEntry, OwnerCredentialStore } from "../../src/application/authority.js";

export const PROVIDER = "p2o-inert";
export const MODEL = "inert";
export const SELECTION: RuntimeSelection = { provider: PROVIDER, model: MODEL, thinking: "max" as Thinking };
export const MODEL_ENTRY = Object.freeze({
  id: MODEL, reasoning: true, contextWindow: 32_000, maxTokens: 1_024,
  thinkingLevelMap: { max: "max-effort", high: "high-effort", low: "low-effort", minimal: "min-effort", off: null },
});

export const REAL_PROVIDER_SECRET = "sk-live-t2-provider-0123456789abcdef";
export const SECOND_PROVIDER_SECRET = "sk-live-t2-secondary-fedcba9876543210";
export const TARGET_SECRET_A = "t2-target-secret-a-0123456789abcdef";
export const TARGET_SECRET_B = "t2-target-secret-b-fedcba9876543210";

export const ACCOUNT_A = "t2-account-a";
export const ACCOUNT_B = "t2-account-b";
export const ACCOUNT_MISSING = "t2-account-missing";
export const AT = "2026-10-02T10:00:00.000Z";
export const ACCOUNT_EXPIRES = "2026-10-02T11:00:00.000Z";
export const TARGET_ID_A = "t2-target-a";
export const TARGET_ID_B = "t2-target-b";

export interface RecordedRequest { path: string; authorization?: string; xApiKey?: string; body: string }
export interface FixtureServer { origin: string; requests: RecordedRequest[]; close(): Promise<void> }

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => { server.removeListener("error", reject); resolve(); });
  });
}

function originOf(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind a loopback TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
}

/** Deterministic streaming upstream provider. Records exactly what the gateway injected. */
export async function startUpstream(): Promise<FixtureServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requests.push({
        path: request.url ?? "",
        ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}),
        ...(typeof request.headers["x-api-key"] === "string" ? { xApiKey: request.headers["x-api-key"] } : {}),
        body,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"id":"chatcmpl-t2","object":"chat.completion.chunk","choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: [DONE]\n\n');
    });
  });
  await listen(server);
  return { origin: originOf(server), requests, close: () => closeServer(server) };
}

/** Inert authenticated target. Counts requests so a denied dispatch can prove "no request issued". */
export async function startTarget(): Promise<FixtureServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requests.push({
        path: request.url ?? "",
        ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}),
        ...(typeof request.headers["x-api-key"] === "string" ? { xApiKey: request.headers["x-api-key"] } : {}),
        body,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}\n');
    });
  });
  await listen(server);
  return { origin: originOf(server), requests, close: () => closeServer(server) };
}

export function httpRequestWith(method: "GET" | "POST", url: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = httpRequest({
      hostname: parsed.hostname, port: parsed.port, path: `${parsed.pathname}${parsed.search}`, method,
      headers: { ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}), ...headers },
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: data }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

export const httpPost = (url: string, body: string, headers: Record<string, string> = {}) => httpRequestWith("POST", url, body, headers);

export async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export function runtimeOptionsFor(controlRoot: string, gateway: ManagedRuntimeOptions["gateway"]): ManagedRuntimeOptions {
  return { controlRoot, piBinary: process.execPath, nodeBinary: process.execPath, gateway, pollMs: 25, startupTimeoutMs: 3_000, stopGraceMs: 100 };
}

export function runtimeRequestFor(workspace: string): RuntimeRequest {
  return {
    runId: "t2-run", taskId: "t2-task", attemptId: "attempt-1", workspace,
    scopeDigest: "b".repeat(64), inputDigest: "c".repeat(64), deadlineAt: Date.now() + 60_000,
    prompt: "Offline T2 credential fixture only; do not contact any target",
    requested: { ...SELECTION }, toolPolicy: { mode: "trusted-fixture", allowUnsandboxedHostTools: true, tools: [] },
  };
}

export function runtimeHandleFor(controlDir: string, workspace: string, attemptId = "attempt-1", requested: RuntimeSelection = SELECTION): RuntimeHandle {
  return {
    version: 1, kind: "headless", runId: "t2-run", taskId: "t2-task", attemptId, ownerToken: "t2-owner-token-0123456789",
    workspace, scopeDigest: "b".repeat(64), inputDigest: "c".repeat(64), deadlineAt: Date.now() + 60_000,
    requested: { ...requested }, toolPolicy: { mode: "trusted-fixture", allowUnsandboxedHostTools: true, tools: [] },
    createdAt: Date.now(), status: "starting", controlDir,
    sessionFile: path.join(controlDir, "session.jsonl"), sessionId: "t2-session", launchIntent: false,
    native: { processes: [] }, observed: [], events: [], nextCursor: 1, logTail: "", droppedLogBytes: 0,
  };
}

export async function prepareDirs(root: string): Promise<{ controlRoot: string; controlDir: string; workspace: string }> {
  const controlRoot = path.join(root, "controller");
  const controlDir = path.join(controlRoot, "t2-attempt");
  const workspace = path.join(root, "workspace");
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  return { controlRoot, controlDir, workspace };
}

/** Concatenates every regular file under `root` (used as a grep-based artifact assertion). */
export async function readTree(root: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) parts.push((await readFile(full)).toString("utf8"));
    }
  };
  await walk(root);
  return parts.join("\n");
}

/** Raw, percent-encoded and base64 forms: the shapes a leak could take in a text artifact. */
export function credentialForms(secret: string): string[] {
  return [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")];
}

export function assertNoCredentialForm(text: string, secret: string): void {
  for (const form of credentialForms(secret)) {
    assert.equal(text.includes(form), false, `artifact contained credential material (${form.length} bytes)`);
  }
}

export class RecordingCredentialStore implements OwnerCredentialStore {
  readonly reads: string[] = [];
  private readonly entries = new Map<string, OwnerCredentialEntry>();
  constructor(entries: readonly OwnerCredentialEntry[]) {
    for (const entry of entries) this.entries.set(entry.accountId, entry);
  }
  async read(accountId: string): Promise<OwnerCredentialEntry | undefined> {
    this.reads.push(accountId);
    return this.entries.get(accountId);
  }
  async list(): Promise<readonly string[]> { return [...this.entries.keys()]; }
}

export function webTarget(id: string, accounts: string[]): WebTarget {
  return {
    id, origins: ["https://target.invalid"], pathPrefixes: ["/"], allowedCidrs: ["127.0.0.1/32"], methods: ["GET", "POST"],
    actions: ["read", "mutate"], accounts,
    limits: { maxRequests: 10, maxBytes: 4_096, maxConcurrent: 1, rate: { requests: 10, windowMs: 1_000 } },
  };
}

export function approvedAccount(id: string, targetIds: string[], actions: Action[], expiresAt: string): ApprovedAccount {
  return { id, targetIds, actions, expiresAt, kind: "credential" };
}

export function decisionFor(account: ApprovedAccount, target: WebTarget, action: Action = "read"): Decision {
  const grant: CapabilityGrant = {
    id: "grant-t2", taskId: "t2-task", attemptId: "attempt-1", role: "worker", capabilities: ["http.request"],
    targetIds: [target.id], actions: [action], accountIds: [account.id], expiresAt: account.expiresAt, maxCalls: 10, maxArtifactBytes: 4_096,
  };
  return { scopeDigest: "a".repeat(64), grant, target, account, action, capability: "http.request" };
}

/** Fixture run manifest for the interface-backend deny tests; identical shape to the interface suite. */
export function runManifestFor(runId: string): Record<string, unknown> {
  return {
    schemaVersion: 1, runId, createdAt: "2026-10-02T09:59:00.000Z", state: "active",
    authorization: {
      reference: "t2-owner-approved-offline-fixture", authorizedBy: "t2-fixture-owner",
      validFrom: "2026-10-02T09:00:00.000Z", expiresAt: "2026-10-02T12:00:00.000Z",
      targets: [{ id: "fixture", kind: "lab", locator: "fixtures/t2-local-lab" }], exclusions: [], allowedActions: ["review", "local-test"],
    },
    budgets: {
      deadlineAt: "2026-10-02T11:30:00.000Z", maxRequests: 10, maxBytes: 1_000_000, maxToolCalls: 100, maxTokens: 10_000,
      maxCostUsd: 10, maxAttempts: 3, maxTasks: 10, maxDepth: 3, maxConcurrency: 3, reportReserveMs: 60_000, targetRequestLimits: { fixture: 5 },
    },
    requestedRuntime: { adapter: "headless", selection: { provider: "fixture-provider", model: "fixture-model", thinking: "max" }, requiredCapabilities: ["ownsLifecycle"] },
    allowedCapabilities: ["source.read", "local.test"],
  };
}

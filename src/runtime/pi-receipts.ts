/** Explicitly loaded public Pi extension. No private Pi/Herdr imports or credential access. */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { PiReceiptFile, RuntimeSelection, Thinking, WorkerConfig } from "./types.js";

// [T2] A worker must never run with real provider or target credential material in its environment or
// isolated provider catalog. Only the controller-minted placeholder is acceptable; anything else fails
// closed before the first model turn. Values are never echoed into the receipt, only the offending key/name.
const credentialShape = /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const placeholderShape = /^(?:p2o-gateway-placeholder|p2o-gw\.v1\.[0-9a-f]{8}\.[0-9a-f]{32})$/;
const loopbackHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
};

interface IsolatedProvider { apiKey?: unknown; baseUrl?: unknown }

function isolatedProviders(config: WorkerConfig): Record<string, IsolatedProvider> | undefined {
  const agentDir = config.env.PI_CODING_AGENT_DIR;
  if (typeof agentDir !== "string" || !agentDir) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(`${agentDir}/models.json`, "utf8")); } catch { return undefined; }
  const providers = (parsed as { providers?: unknown } | undefined)?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
  return providers as Record<string, IsolatedProvider>;
}

/** Credential-free attestation of the isolated provider catalog written by the controller. */
function isolatedProviderError(config: WorkerConfig): string | undefined {
  const providers = isolatedProviders(config);
  if (!providers) return undefined;
  const entry = providers[config.requested.provider];
  if (!entry) return `Isolated provider ${config.requested.provider} is not provisioned`;
  if (typeof entry.apiKey !== "string" || !placeholderShape.test(entry.apiKey)) return "Isolated provider credential is not a controller-minted placeholder";
  if (typeof entry.baseUrl !== "string") return "Isolated provider base URL is missing";
  let url: URL;
  try { url = new URL(entry.baseUrl); } catch { return "Isolated provider base URL is invalid"; }
  if (!loopbackHost(url.hostname) || url.username || url.password) return "Isolated provider base URL must be a credential-free loopback endpoint";
  for (const [name, provider] of Object.entries(providers)) {
    if (name === config.requested.provider) continue;
    if (typeof provider?.apiKey === "string" && credentialShape.test(provider.apiKey)) return `Isolated provider ${name} carries a credential-shaped key`;
  }
  return undefined;
}

// Structural subset of the documented public ExtensionAPI, allowing dependency-free compilation.
interface Context {
  cwd: string;
  model?: { provider: string; id: string };
  thinkingLevel?: Thinking;
  sessionManager: { getSessionFile(): string | undefined };
  isIdle(): boolean;
  shutdown(): void;
}
interface Event {
  type?: string;
  message?: {
    role: string; provider?: string; model?: string; stopReason?: string; errorMessage?: string;
    /** Public Pi assistant-message usage, when the provider reported it. */
    usage?: { inputTokens?: unknown; outputTokens?: unknown; costUsd?: unknown; input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; reasoning?: unknown; cost?: { total?: unknown } };
  };
  toolName?: string;
  text?: string;
}

/** [T3] Provider-reported usage, bounded to finite non-negative integers; never worker-authored prose. */
function receiptUsage(msg: Event["message"]): { inputTokens: number; outputTokens: number; reportedCostUsd?: number } | undefined {
  const usage = msg?.usage;
  if (!usage) return undefined;
  const count = (value: unknown): number | undefined => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
  const inputBase = count(usage.input ?? usage.inputTokens), output = count(usage.output ?? usage.outputTokens);
  const cacheRead = count(usage.cacheRead ?? 0), cacheWrite = count(usage.cacheWrite ?? 0);
  if (inputBase === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  // Pi's cache counters are disjoint input; output already includes reasoning.
  const input = inputBase + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(input)) return undefined;
  const cost = usage.cost?.total ?? usage.costUsd;
  const reportedCostUsd = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost <= 1_000_000 ? cost : undefined;
  return { inputTokens: input as number, outputTokens: output as number, ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }) };
}
interface PiAPI {
  on(name: string, callback: (event: Event, ctx: Context) => unknown): void;
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string; sourceInfo: { source: string; path: string } }>;
}
export default function receiptExtension(pi: PiAPI): void {
  const config = JSON.parse(readFileSync(process.env.P2O_CONFIG ?? "", "utf8")) as WorkerConfig;
  const receipt: PiReceiptFile = { token: config.token, seq: 0, ready: false, events: [] };
  function flush(): void {
    const tmp = `${config.receiptFile}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(receipt)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, config.receiptFile);
  }
  function check(ctx: Context): string | undefined {
    if (process.env.P2O_ISOLATED !== config.token) return "Worker was not launched with isolated environment";
    const extras = Object.keys(process.env).filter((k) => !(k in config.env) && !["AI_AGENT", "PI_CODING_AGENT"].includes(k));
    if (extras.length) return `Unexpected environment keys: ${extras.slice(0, 8).join(",")}`;
    // [T2] Fail closed on credential-shaped environment values and non-placeholder provider catalogs.
    const credentialKey = Object.keys(process.env).find((name) => credentialShape.test(process.env[name] ?? ""));
    if (credentialKey) return `Credential-shaped environment value is present: ${credentialKey}`;
    const providerError = isolatedProviderError(config);
    if (providerError) return providerError;
    if (ctx.cwd !== config.workspace || ctx.sessionManager.getSessionFile() !== config.sessionFile) return "Workspace/session identity changed";
    if (!ctx.model || !ctx.thinkingLevel) return "Pi did not expose effective provider/model/thinking state";
    const active = pi.getActiveTools().sort();
    if (JSON.stringify(active) !== JSON.stringify([...config.toolPolicy.tools].sort())) return "Active tool allowlist mismatch";
    if (config.toolPolicy.mode === "sandbox-extension") {
      const all = pi.getAllTools();
      for (const name of active) {
        const tool = all.find((t) => t.name === name);
        if (!tool || tool.sourceInfo.source === "builtin" || tool.sourceInfo.path !== config.toolPolicy.extension.path) return "Sandbox tool provenance mismatch";
      }
    }
    if (Date.now() >= config.deadlineAt) return "Absolute deadline exhausted";
    return undefined;
  }
  function record(type: string, ctx: Context, event?: Event): void {
    const selection: RuntimeSelection | undefined = ctx.model && ctx.thinkingLevel ? { provider: ctx.model.provider, model: ctx.model.id, thinking: ctx.thinkingLevel } : undefined;
    const msg = event?.message;
    const assistant = msg?.role === "assistant" && msg.provider && msg.model && msg.stopReason ? { provider: msg.provider, model: msg.model, stopReason: msg.stopReason, ...(msg.errorMessage ? { errorMessage: msg.errorMessage.slice(-1024) } : {}) } : undefined;
    const usage = type === "message_end" && msg?.role === "assistant" ? receiptUsage(msg) : undefined;
    receipt.events.push({ seq: ++receipt.seq, at: Date.now(), type, ...(selection ? { selection } : {}),
      ...(assistant ? { assistant } : {}),
      ...(usage ? { usage } : {}),
      ...(type === "agent_settled" ? { idle: ctx.isIdle() } : {}),
    });
    receipt.events = receipt.events.slice(-64);
    flush();
  }
  pi.on("project_trust", () => ({ trusted: "no", remember: false }));
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
  pi.on("user_bash", () => ({ result: { output: "Interactive host shell is disabled by the runtime", exitCode: 1, cancelled: false, truncated: false } }));
  pi.on("session_start", (_event, ctx) => {
    receipt.error = check(ctx);
    receipt.ready = !receipt.error;
    record("session_start", ctx);
    if (receipt.error) ctx.shutdown();
  });
  pi.on("input", (event, ctx) => {
    const error = check(ctx);
    if (error || !receipt.ready || /^[!\/]/.test(event.text ?? "")) {
      receipt.error = error ?? "Runtime refuses command expansion";
      flush(); ctx.shutdown(); return { action: "handled" };
    }
    return { action: "continue" };
  });
  pi.on("tool_call", (event, ctx) => {
    const error = check(ctx);
    if (error || !config.toolPolicy.tools.includes(event.toolName ?? "")) {
      receipt.error = error ?? "Tool not granted"; flush();
      return { block: true, terminate: true, reason: receipt.error };
    }
    return undefined;
  });
  for (const type of ["model_select", "thinking_level_select", "agent_start", "agent_end", "message_end", "agent_settled", "session_shutdown"]) {
    pi.on(type, (event, ctx) => {
      if (type === "message_end" && event.message?.role !== "assistant") return;
      record(type, ctx, event);
      // One dispatched task per attempt. Settlement is not merely agent_end.
      if (type === "agent_settled" && ctx.isIdle()) ctx.shutdown();
    });
  }
}

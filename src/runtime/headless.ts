import path from "node:path";
import { ManagedRuntime, type Entry } from "./managed.js";
import { paths, taskPrompt } from "./config.js";
import { readJson, until } from "./io.js";
import { RpcPeer } from "./rpc.js";
import { processIdentity } from "./processes.js";
import type { PiReceiptFile, RuntimeSelection, Thinking, WorkerConfig } from "./types.js";

export class HeadlessRuntimeAdapter extends ManagedRuntime {
  readonly kind = "headless" as const;
  protected async launch(e: Entry, config: WorkerConfig, prompt: string): Promise<void> {
    await this.launchIntent(e);
    e.dispatched = true;
    let child: ReturnType<typeof this.dep.spawn>;
    try {
      child = this.dep.spawn(paths(this.options).node, [paths(this.options).guardian, path.join(e.h.controlDir, "worker.json")], {
        cwd: e.h.workspace, env: config.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) { e.dispatched = false; throw err; }
    e.child = child;
    child.once("error", (err) => {
      // spawn error without PID is positive evidence that no process was dispatched.
      if (!child.pid) e.dispatched = false;
      if (!e.closing) void this.fail(e, err);
    });
    child.stderr!.on("data", (chunk: Buffer) => this.log(e, chunk.toString("utf8")));
    child.once("close", (code, signal) => {
      e.h.exit = { code, signal };
      if (!e.closing) {
        const completed = code === 0 && e.settled && e.assistant && !["error", "aborted"].includes(e.assistant.stopReason);
        if (!completed) e.h.startupError ??= e.assistant?.errorMessage ?? `Worker exited before successful settled response (code ${code}, signal ${signal})`;
        void this.stop(e.h, { reason: completed ? "completed" : "failed" }).catch(() => {});
      }
    });
    e.rpc = new RpcPeer(child, e.h.deadlineAt, this.limits.frameBytes, (event) => {
      const type = event.type as string;
      if (type === "message_update") {
        const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (delta?.type === "text_delta" && typeof delta.delta === "string") { this.log(e, delta.delta); this.event(e, "text", delta.delta); }
        return; // never log raw state, headers, arguments, or reasoning deltas
      }
      this.event(e, `rpc:${type}`);
      if (type === "agent_start" && !e.closing) e.h.status = "running";
      if (type === "message_end" || type === "turn_end") {
        const msg = event.message as { role?: string; provider?: string; model?: string; stopReason?: string; errorMessage?: string } | undefined;
        if (msg?.role === "assistant" && typeof msg.provider === "string" && typeof msg.model === "string") {
          if (!this.selection(e, "pi-event", "assistant-response", { provider: msg.provider, model: msg.model })) void this.fail(e, new Error("Observed assistant runtime mismatch"));
          e.assistant = { stopReason: msg.stopReason ?? "error", errorMessage: msg.errorMessage };
        }
      }
      if (type === "agent_settled") { e.settled = true; if (!e.closing) e.h.status = "settled"; }
      if (type === "extension_ui_request" && typeof event.id === "string" && ["select", "confirm", "input", "editor"].includes(String(event.method))) {
        // No automatic approval of worker dialogs.
        child.stdin!.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
      }
      if (type === "extension_error") void this.fail(e, new Error(`Approved Pi extension failed: ${String(event.error)}`));
    }, (error) => { if (!e.closing) void this.fail(e, error); }, () => e.deadline.now(), e.abort.signal);
    const startupEnd = Math.min(e.h.deadlineAt, e.deadline.now() + (this.options.startupTimeoutMs ?? 10_000));
    // Capture kernel identity independently; guardian also journals before it launches Pi.
    if (child.pid) {
      const identity = (await this.dep.processes.snapshot()).find((p) => p.pid === child.pid);
      if (identity) { e.h.native.guardian = processIdentity(identity); e.family.add([identity]); e.h.native.processes = e.family.identities(); await this.save(e); }
    }
    while (e.deadline.now() < startupEnd) {
      this.assertOpen(e);
      await this.refresh(e);
      const receipt = await readJson<PiReceiptFile>(config.receiptFile, 128 * 1024);
      if (receipt?.ready) break;
      await this.dep.sleep(Math.min(25, Math.max(1, startupEnd - e.deadline.now())));
    }
    this.assertOpen(e);
    const ready = await readJson<PiReceiptFile>(config.receiptFile, 128 * 1024);
    if (!ready?.ready || ready.token !== e.h.ownerToken) throw new Error("Pi startup receipt/readiness timeout");
    const state = await until(e.rpc.request("get_state"), startupEnd, () => e.deadline.now(), e.abort.signal);
    const model = state.model as { provider?: string; id?: string } | undefined;
    const selected: RuntimeSelection = { provider: model?.provider ?? "", model: model?.id ?? "", thinking: state.thinkingLevel as Thinking };
    if (!this.selection(e, "rpc-state", "get_state", selected)) throw new Error("Pi effective provider/model/thinking does not match request");
    if (state.sessionFile !== e.h.sessionFile || state.sessionId !== e.h.sessionId || state.isStreaming !== false) throw new Error("Pi startup session identity/readiness mismatch");
    await this.phase(e, "ready", "Pi effective runtime and tool-policy receipts verified");
    this.assertOpen(e);
    await until(e.rpc.request("prompt", { message: taskPrompt(prompt) }), e.h.deadlineAt, () => e.deadline.now(), e.abort.signal);
    this.event(e, "prompt-delivered", "Pi RPC accepted prompt; acceptance is not result completion");
    if (e.h.status === "ready") e.h.status = "prompt-delivered";
    await this.save(e);
  }
}
export function createHeadlessRuntime(options: ConstructorParameters<typeof HeadlessRuntimeAdapter>[0]): HeadlessRuntimeAdapter { return new HeadlessRuntimeAdapter(options); }

import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";
import { errorText, MAX_TIMER_MS } from "./io.js";

/** Strict LF-only, UTF-8 JSONL with bounded frames and pending commands. */
export class RpcPeer {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private seq = 0;
  private closed = false;
  private readonly pending = new Map<string, { resolve(v: Record<string, unknown>): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly child: ChildProcess, private readonly deadlineAt: number, private readonly maxFrameBytes: number,
    private readonly event: (value: Record<string, unknown>) => void, private readonly fatal: (error: Error) => void,
    private readonly now: () => number = Date.now, signal?: AbortSignal) {
    child.stdout!.on("data", (chunk: Buffer) => {
      try { this.feed(this.decoder.write(chunk)); } catch (e) { this.close(); this.fatal(new Error(errorText(e))); }
    });
    child.stdout!.on("end", () => {
      try { this.feed(this.decoder.end()); if (this.buffer) throw new Error("Incomplete RPC JSONL frame"); }
      catch (e) { this.fatal(new Error(errorText(e))); }
    });
    child.stdin!.on("error", (e) => { this.close(); this.fatal(e); });
    child.once("close", () => this.close());
    signal?.addEventListener("abort", () => this.close(), { once: true });
  }
  private feed(text: string): void {
    let start = 0;
    if (this.closed) return;
    for (;;) {
      const end = text.indexOf("\n", start);
      const part = text.slice(start, end < 0 ? undefined : end);
      if (Buffer.byteLength(this.buffer) + Buffer.byteLength(part) > this.maxFrameBytes) throw new Error("RPC frame limit exceeded");
      this.buffer += part;
      if (end < 0) break;
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = ""; start = end + 1;
      if (!line) continue;
      const value = JSON.parse(line) as Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") throw new Error("Invalid RPC event shape");
      if (value.type === "response") {
        const waiter = this.pending.get(String(value.id));
        if (!waiter) continue;
        this.pending.delete(String(value.id)); clearTimeout(waiter.timer);
        if (value.success !== true) waiter.reject(new Error(`Pi RPC ${String(value.command)} failed: ${String(value.error ?? "unknown error")}`));
        else waiter.resolve((value.data ?? {}) as Record<string, unknown>);
      } else this.event(value);
    }
  }
  request(type: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed || this.now() >= this.deadlineAt) return Promise.reject(new Error("RPC closed/deadline exhausted"));
    if (this.pending.size >= 8) return Promise.reject(new Error("RPC pending request limit exceeded"));
    const id = `p2o-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi RPC ${type} deadline exhausted`)); }, Math.min(MAX_TIMER_MS, Math.max(1, this.deadlineAt - this.now())));
      this.pending.set(id, { resolve, reject, timer });
      const frame = `${JSON.stringify({ ...fields, id, type })}\n`;
      if (Buffer.byteLength(frame) > this.maxFrameBytes) { clearTimeout(timer); this.pending.delete(id); reject(new Error("RPC request frame limit exceeded")); return; }
      this.child.stdin!.write(frame, (e) => { if (e) { const pending = this.pending.get(id); this.pending.delete(id); clearTimeout(timer); pending?.reject(e); } });
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(new Error("RPC connection closed")); }
    this.pending.clear(); this.buffer = "";
  }
}

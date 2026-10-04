import { spawn } from "node:child_process";
import type { CommandRunner, RuntimeDependencies } from "./types.js";
import { LinuxProcessProbe } from "./processes.js";
import { MAX_TIMER_MS } from "./io.js";

export const runCommand: CommandRunner = async (binary, args, options) => {
  if (options.signal?.aborted || Date.now() >= options.deadlineAt) throw new Error("Command cancelled/deadline exhausted");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", size = 0, error: Error | undefined;
    const kill = (why: string) => {
      error ??= new Error(why);
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const timer = setTimeout(() => kill("Command absolute deadline exhausted"), Math.min(MAX_TIMER_MS, Math.max(1, options.deadlineAt - Date.now())));
    const onAbort = () => kill("Command cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const data = (target: "stdout" | "stderr", chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) { kill("Command output limit exceeded"); return; }
      if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
    };
    child.stdout!.on("data", (chunk: Buffer) => data("stdout", chunk));
    child.stderr!.on("data", (chunk: Buffer) => data("stderr", chunk));
    child.once("error", (e) => { error = e; });
    child.once("close", (code) => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve({ stdout, stderr, code });
    });
  });
};
export function dependencies(overrides: Partial<RuntimeDependencies> = {}): RuntimeDependencies {
  return { now: Date.now, monoNow: () => performance.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    spawn: (bin, args, opts) => spawn(bin, [...args], opts), command: runCommand, processes: new LinuxProcessProbe(), ...overrides };
}

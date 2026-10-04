import { constants } from "node:fs";
import { open, mkdir, realpath, rename, unlink, lstat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

/** A wall clock earlier than the durable attempt creation time by more than this is a clock step,
 *  not scheduling jitter, and the attempt's absolute deadline can no longer be trusted. */
export const CLOCK_SKEW_TOLERANCE_MS = 1_000;
/** Node fires a timeout scheduled beyond 2^31-1 ms immediately; long waits must be clamped and
 *  re-armed instead of converting a far deadline into an immediate cancellation. */
export const MAX_TIMER_MS = 2_147_483_647;
/**
 * One absolute epoch deadline (`RuntimeRequest.deadlineAt`, durable and shared with workers) tracked
 * on a monotonic timeline. Wall-clock steps must never extend a job's real budget: `now()` is the
 * running maximum of the wall clock and the monotonic projection, so it only ever moves forward.
 * A backwards step therefore leaves the remaining budget anchored to elapsed monotonic time instead
 * of re-granting it; a forwards step can only shorten the remaining budget (fail closed).
 */
export class Deadline {
  private readonly anchorEpoch: number;
  private readonly anchorMono: number;
  private last: number;
  constructor(readonly at: number, private readonly epochNow: () => number,
    private readonly monoNow: () => number = () => performance.now()) {
    this.anchorEpoch = epochNow();
    this.anchorMono = monoNow();
    this.last = this.anchorEpoch;
  }
  /** Non-decreasing epoch-shaped clock for every wait and comparison against `at`. */
  now(): number {
    const projected = this.anchorEpoch + Math.max(0, this.monoNow() - this.anchorMono);
    this.last = Math.max(this.last, projected, this.epochNow());
    return this.last;
  }
  remaining(): number { return this.at - this.now(); }
  exhausted(): boolean { return this.now() >= this.at; }
  /** The durable handle predates this process's wall clock: its remaining budget is unknowable. */
  behind(createdAt: number, tolerance = CLOCK_SKEW_TOLERANCE_MS): boolean {
    return this.epochNow() < createdAt - tolerance;
  }
}
export function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function errorText(error: unknown): string { return tail(error instanceof Error ? error.message : String(error), 4096); }
export function tail(text: string, bytes: number): string {
  const data = Buffer.from(text);
  if (data.length <= bytes) return text;
  let start = data.length - bytes;
  while (start < data.length && (data[start]! & 0xc0) === 0x80) start++;
  return data.subarray(start).toString("utf8");
}
export function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
export async function privateDirectory(dir: string): Promise<string> {
  if (!path.isAbsolute(dir)) throw new Error("Controller directory must be absolute");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()) {
    throw new Error(`Controller directory must be an owned, non-symlink 0700 directory: ${dir}`);
  }
  if (await realpath(dir) !== path.resolve(dir)) throw new Error("Controller directory ancestors must be canonical");
  return dir;
}
export async function readBounded(file: string, limit: number): Promise<Buffer> {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat();
    // An opened snapshot can become nlink=0 during an atomic replacement; it remains valid.
    if (!st.isFile() || st.nlink > 1 || st.size > limit) throw new Error(`Unsafe or oversized runtime file: ${file}`);
    const buf = Buffer.alloc(Math.min(st.size + 1, limit + 1));
    let count = 0;
    while (count < buf.length) {
      const { bytesRead } = await fd.read(buf, count, buf.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > limit || count > st.size) throw new Error(`Runtime file changed during read: ${file}`);
    return buf.subarray(0, count);
  } finally { await fd.close(); }
}
export async function readJson<T>(file: string, limit = 1024 * 1024): Promise<T | undefined> {
  try { return JSON.parse((await readBounded(file, limit)).toString("utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
/** Atomic replacement + fsync file and directory. No unbounded append-only worker log. */
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value)}\n`);
}
export async function atomicWrite(file: string, value: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = await open(tmp, "wx", 0o600);
  try { await fd.writeFile(value); await fd.sync(); }
  catch (e) { await unlink(tmp).catch(() => {}); throw e; }
  finally { await fd.close(); }
  try {
    await rename(tmp, file);
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(tmp).catch(() => {}); }
}
export async function until<T>(work: Promise<T>, deadlineAt: number, now: () => number = Date.now, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error("Operation cancelled");
  const remaining = deadlineAt - now();
  if (remaining <= 0) throw new Error("Absolute deadline exhausted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Absolute deadline exhausted")), Math.min(remaining, 2_147_483_647));
      abort = () => reject(new Error("Operation cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    // If the race was lost (deadline/abort), the underlying work may still reject later; keep it
    // observed so a late failure can never surface as an unhandled rejection after until() returned.
    void work.catch(() => {});
  }
}
export function sessionData(data: Buffer): { header: Record<string, unknown>; lines: string[]; leafId: string | null } {
  const text = data.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("Session has an incomplete final JSONL record");
  const lines = text.trimEnd().split("\n");
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  if (header.type !== "session" || header.version !== 3 || typeof header.id !== "string") throw new Error("Unsupported Pi session header");
  const ids = new Set<string>(); let leafId: string | null = null;
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (typeof entry.type !== "string" || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) ||
      (entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))) throw new Error("Invalid Pi v3 session entry/parent chain");
    ids.add(entry.id);
    if (entry.type !== "label") leafId = entry.id;
  }
  return { header, lines, leafId };
}

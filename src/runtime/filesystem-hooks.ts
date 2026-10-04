import { open, unlink } from "node:fs/promises";
import path from "node:path";
import type { RuntimeHandle, RuntimeHooks } from "./types.js";
import { atomicJson, digest, privateDirectory, readJson } from "./io.js";

export function attemptKey(h: Pick<RuntimeHandle, "runId" | "taskId" | "attemptId">): string {
  return digest(JSON.stringify([h.runId, h.taskId, h.attemptId]));
}
/** Local single-host durable fencing. No lease expiry or automatic stale lock deletion. */
export function filesystemHooks(root: string): RuntimeHooks {
  const handlePath = (h: Pick<RuntimeHandle, "runId" | "taskId" | "attemptId">) => path.join(root, `attempt-${attemptKey(h)}.json`);
  const fencePath = (h: RuntimeHandle) => path.join(root, `workspace-${digest(h.workspace)}.lock`);
  return {
    async claim(h) {
      await privateDirectory(root);
      let lock;
      try { lock = await open(fencePath(h), "wx", 0o600); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
      try {
        await lock.writeFile(JSON.stringify({ token: h.ownerToken, attempt: attemptKey(h) }));
        await lock.sync();
        // Attempts are never reused, even after a verified release.
        const fd = await open(handlePath(h), "wx", 0o600);
        try { await fd.writeFile(`${JSON.stringify(h)}\n`); await fd.sync(); }
        finally { await fd.close(); }
        const directory = await open(root, "r");
        try { await directory.sync(); } finally { await directory.close(); }
        return true;
      } catch (e) {
        await unlink(fencePath(h));
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
      } finally { await lock.close(); }
    },
    async release(h) {
      const lock = await readJson<{ token: string }>(fencePath(h), 4096);
      if (!lock) return;
      if (lock.token !== h.ownerToken) throw new Error("Writer fence belongs to a different owner");
      await unlink(fencePath(h));
      const fd = await open(root, "r");
      try { await fd.sync(); } finally { await fd.close(); }
    },
    async persistHandle(h) {
      const old = await readJson<RuntimeHandle>(handlePath(h));
      if (!old || old.ownerToken !== h.ownerToken) throw new Error("Unknown or stale attempt owner");
      await atomicJson(handlePath(h), h);
    },
    async loadHandle(h) { return readJson<RuntimeHandle>(handlePath(h)); },
    // Events are included in the bounded, durable handle snapshot. A store may export them to its outbox.
    async emit() {},
    // Standalone replacement requires an explicit current-authorization validator.
    async validateResume() { return false; },
  };
}

import { spawn } from "node:child_process";
import {
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

/** Linux local-filesystem ownership. The parent retains the locked open-file
 * description after flock exits; the kernel releases it when this process dies.
 * owner.guard MUST NOT be removed or replaced, even after a crash.
 */
export async function acquireJournalOwnership(
  directory: string,
  name: "owner" | "service" = "owner",
): Promise<() => Promise<void>> {
  if (process.platform !== "linux") return exclusiveFileOwnership(directory, name);
  const guard = await open(path.join(directory, `${name}.guard`), "a+", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      // fd 3 is a duplicate of the parent's file description. No long-running
      // lock helper, heartbeat timeout, PID lease, shell, or wallet environment.
      const child = spawn("flock", ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "pipe", guard.fd],
        env: { PATH: process.env.PATH },
        timeout: 5000,
      });
      child.stderr?.resume();
      child.once("error", () =>
        reject(
          new Error("Journal ownership requires util-linux flock on Linux"),
        ),
      );
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                "Journal already owned or filesystem locking unavailable",
              ),
            ),
      );
    });
    const metadata = path.join(directory, `${name}.lock`);
    let previous;
    try {
      previous = JSON.parse(await readFile(metadata, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Unreadable legacy ownership metadata; inspect before migration",
        );
    }
    // Older releases used only an exclusive PID file. Do not take over a live
    // old-version writer which does not participate in kernel locking.
    if (previous && previous.protocol !== "linux-flock-v1") {
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1)
        throw new Error("Invalid legacy owner metadata");
      try {
        process.kill(previous.pid, 0);
        throw new Error("Legacy journal owner is still alive");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
    }
    const temp = await open(path.join(directory, `${name}.lock.tmp`), "w", 0o600);
    try {
      await temp.writeFile(
        JSON.stringify({
          protocol: "linux-flock-v1",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      );
      await temp.sync();
    } finally {
      await temp.close();
    }
    await rename(path.join(directory, `${name}.lock.tmp`), metadata);
    // Keep metadata across clean shutdown too. The kernel lock is authoritative;
    // stale/reused PID values cannot block or authorize another new-version owner.
    let closed = false;
    return async () => {
      if (!closed) {
        closed = true;
        await guard.close();
      }
    };
  } catch (e) {
    await guard.close();
    throw e;
  }
}

/** Preserve the prior fail-closed behavior on unsupported platforms. */
async function exclusiveFileOwnership(directory: string, prefix: string) {
  const name = path.join(directory, `${prefix}.lock`);
  const file: FileHandle = await open(name, "wx", 0o600);
  try {
    await file.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    await file.sync();
  } catch (e) {
    await file.close();
    await unlink(name);
    throw e;
  }
  await file.close();
  let closed = false;
  return async () => {
    if (!closed) {
      closed = true;
      await unlink(name);
    }
  };
}

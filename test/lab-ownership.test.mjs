import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireJournalOwnership } from "../dist/lab/ownership.js";
const linuxOnly = { skip: process.platform !== "linux" && "Requires Linux flock ownership" };
const nativeOnly = { skip: process.platform === "linux" && "Exercises non-Linux exclusive-file ownership" };
const worker = (directory) => {
  const process = fork(
    "test/fixtures/lab-recovery/lock-worker.mjs",
    [directory],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  process.stderr.resume();
  const ready = new Promise((resolve, reject) => {
    process.once("message", resolve);
    process.once("error", reject);
  });
  const exited = new Promise((resolve) =>
    process.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { process, ready, exited };
};
async function temp(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), "lab-owner-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("kernel lock survives helper exit and excludes a second owner in the same process", linuxOnly, () =>
  temp(async (directory) => {
    const release = await acquireJournalOwnership(directory);
    try {
      await assert.rejects(acquireJournalOwnership(directory), /already owned/);
    } finally {
      await release();
    }
    const next = await acquireJournalOwnership(directory);
    await next();
  }));

test("a paused live owner cannot lose ownership to contenders", linuxOnly, () =>
  temp(async (directory) => {
    const owner = worker(directory);
    assert.equal((await owner.ready).owned, true);
    try {
      owner.process.kill("SIGSTOP");
      for (let i = 0; i < 4; i++)
        await assert.rejects(
          acquireJournalOwnership(directory),
          /already owned/,
        );
    } finally {
      owner.process.kill("SIGCONT");
      owner.process.send("close");
      await owner.exited;
    }
  }));

test("six competing restarts after SIGKILL elect exactly one owner without file deletion", linuxOnly, () =>
  temp(async (directory) => {
    const original = worker(directory);
    assert.equal((await original.ready).owned, true);
    original.process.kill("SIGKILL");
    await original.exited;
    const metadataBefore = await readFile(
      path.join(directory, "owner.lock"),
      "utf8",
    );
    assert.equal(JSON.parse(metadataBefore).pid, original.process.pid);
    const contenders = Array.from({ length: 6 }, () => worker(directory));
    try {
      const results = await Promise.all(contenders.map((c) => c.ready));
      assert.equal(results.filter((r) => r.owned).length, 1);
      const winner = contenders[results.findIndex((r) => r.owned)];
      assert.equal(
        JSON.parse(await readFile(path.join(directory, "owner.lock"), "utf8"))
          .pid,
        winner.process.pid,
      );
      await assert.rejects(acquireJournalOwnership(directory), /already owned/);
    } finally {
      for (const c of contenders)
        if (c.process.connected) c.process.send("close");
      await Promise.all(contenders.map((c) => c.exited));
    }
  }));

test("new-protocol stale metadata cannot block recovery through PID reuse", linuxOnly, () =>
  temp(async (directory) => {
    await writeFile(
      path.join(directory, "owner.lock"),
      JSON.stringify({ protocol: "linux-flock-v1", pid: process.pid }),
    );
    const release = await acquireJournalOwnership(directory);
    await release();
  }));

test("migration refuses a live legacy owner and automatically recovers a dead legacy owner", linuxOnly, () =>
  temp(async (directory) => {
    await writeFile(
      path.join(directory, "owner.lock"),
      JSON.stringify({ pid: process.pid }),
    );
    await assert.rejects(acquireJournalOwnership(directory), /still alive/);
    const child = fork(
      "test/fixtures/lab-recovery/lock-worker.mjs",
      [directory],
      { stdio: "ignore" },
    );
    await new Promise((resolve) => child.once("exit", resolve));
    await writeFile(
      path.join(directory, "owner.lock"),
      JSON.stringify({ pid: child.pid }),
    );
    const release = await acquireJournalOwnership(directory);
    await release();
  }));

test("malformed legacy metadata is not treated as proof of a dead owner", linuxOnly, () =>
  temp(async (directory) => {
    await writeFile(path.join(directory, "owner.lock"), "{broken");
    await assert.rejects(
      acquireJournalOwnership(directory),
      /Unreadable legacy/,
    );
    assert.equal(
      await readFile(path.join(directory, "owner.lock"), "utf8"),
      "{broken",
    );
  }));


test("native exclusive-file ownership rejects a second owner and releases on graceful close", nativeOnly, () =>
  temp(async (directory) => {
    const release = await acquireJournalOwnership(directory);
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, "owner.lock"), "utf8"));
      assert.equal(metadata.pid, process.pid);
      assert.equal(metadata.protocol, undefined);
      await assert.rejects(acquireJournalOwnership(directory), { code: "EEXIST" });
      await assert.rejects(stat(path.join(directory, "owner.guard")), { code: "ENOENT" });
    } finally { await release(); }
    await assert.rejects(stat(path.join(directory, "owner.lock")), { code: "ENOENT" });
    await release(); // Idempotent close must not remove a later owner's file.
    const next = await acquireJournalOwnership(directory);
    try {
      await release();
      await assert.rejects(acquireJournalOwnership(directory), { code: "EEXIST" });
    } finally { await next(); }
  }));

test("native exclusive-file ownership excludes a separate process until graceful close", nativeOnly, () =>
  temp(async (directory) => {
    const owner = worker(directory);
    try {
      assert.equal((await owner.ready).owned, true);
      await assert.rejects(acquireJournalOwnership(directory), { code: "EEXIST" });
    } finally {
      if (owner.process.connected) owner.process.send("close");
      await owner.exited;
    }
    const release = await acquireJournalOwnership(directory);
    await release();
  }));

test("native SIGKILL leaves stale ownership fail-closed for every competing restart", nativeOnly, () =>
  temp(async (directory) => {
    const owner = worker(directory);
    try {
      assert.equal((await owner.ready).owned, true);
    } finally {
      owner.process.kill("SIGKILL");
      await owner.exited;
    }
    const metadataBefore = await readFile(path.join(directory, "owner.lock"), "utf8");
    assert.equal(JSON.parse(metadataBefore).pid, owner.process.pid);
    const contenders = Array.from({ length: 6 }, () => worker(directory));
    try {
      const results = await Promise.all(contenders.map(c => c.ready));
      assert.ok(results.every(result => result.owned === false));
      await assert.rejects(acquireJournalOwnership(directory), { code: "EEXIST" });
      assert.equal(await readFile(path.join(directory, "owner.lock"), "utf8"), metadataBefore);
      await assert.rejects(stat(path.join(directory, "owner.guard")), { code: "ENOENT" });
    } finally {
      for (const contender of contenders)
        if (contender.process.connected) contender.process.send("close");
      await Promise.all(contenders.map(c => c.exited));
    }
    // No lock deletion or automatic takeover: discard only this isolated test directory.
  }));

import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../dist/verification/store.js";

test(
  "payment service store survives SIGKILL with persisted state and exclusive ownership",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "verifier-deployment-"),
    );
    const child = fork(
      "test/fixtures/lab-recovery/store-worker.mjs",
      [directory],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    let store;
    try {
      await new Promise((resolve, reject) => {
        child.once("message", resolve);
        child.once("error", reject);
      });
      await assert.rejects(new Store(directory).start(), /already owned/);
      child.kill("SIGKILL");
      await exited;
      assert.equal(
        JSON.parse(await readFile(path.join(directory, "service.lock"), "utf8"))
          .protocol,
        "linux-flock-v1",
      );
      store = new Store(directory);
      await store.start();
      assert.equal(
        (await store.read()).deploymentProbe,
        "persisted-before-crash",
      );
      await assert.rejects(new Store(directory).start(), /already owned/);
    } finally {
      if (child.connected) {
        child.kill("SIGKILL");
        await exited;
      }
      await store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

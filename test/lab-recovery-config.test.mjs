import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { recoveryConfig } from "../scripts/lab-recovery-config.mjs";

const env = { HEDERA_OPERATOR_ID: "0.0.2", HEDERA_OPERATOR_KEY: "test-only-placeholder" };
const localFile = "examples/lab-ticketing/scenarios/local.yaml";

test("recovery mode is explicit and testnet/simulation defaults remain intact", async () => {
  assert.deepEqual((await recoveryConfig([], { env: {} })).config, { mode: "simulated" });
  assert.equal((await recoveryConfig(["--testnet"], { env })).config.mode, "testnet");
  for (const args of [["--local"], ["--local", "--crash"], ["--testnet", "--local", localFile], ["--local", localFile, "--testnet"], ["--unknown"], ["--testnet", "--testnet"], ["--crash"]])
    await assert.rejects(recoveryConfig(args, { env, platform: "linux" }));
});

test("local recovery uses the scenario endpoints and requires local credentials", async () => {
  const result = await recoveryConfig(["--local", localFile], { env });
  const scenario = parse(await readFile(localFile, "utf8"));
  assert.deepEqual(result.config, scenario.network);
  assert.equal(result.live, true);
  await assert.rejects(recoveryConfig(["--local", localFile], { env: {} }), /local operator environment/);
  await assert.rejects(recoveryConfig(["--local", "examples/lab-ticketing/scenarios/testnet-purchase.yaml"], { env }), /no network fallback/);
});

test("crash rejects unsupported ownership platforms before loading a scenario", async () => {
  for (const platform of ["darwin", "win32"])
    await assert.rejects(recoveryConfig(["--local", "does-not-exist.yaml", "--crash"], { env, platform }), /requires Linux/);
  assert.equal((await recoveryConfig(["--local", localFile, "--crash"], { env, platform: "linux" })).crash, true);
});

test("local config rejects missing or remote endpoints and honors dedicated operator variable names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lab-recovery-config-"));
  try {
    const file = path.join(directory, "scenario.yaml");
    const original = parse(await readFile(localFile, "utf8"));
    for (const network of [
      { ...original.network, nodeAddress: undefined },
      { ...original.network, mirrorUrl: undefined },
      { ...original.network, nodeAccountId: undefined },
      { ...original.network, nodeAddress: "testnet.hedera.com:50211" },
      { ...original.network, mirrorUrl: "https://testnet.mirrornode.hedera.com" },
    ]) {
      await writeFile(file, stringify({ ...original, network }));
      await assert.rejects(recoveryConfig(["--local", file], { env }));
    }
    const network = { ...original.network, operatorIdEnv: "SOLO_OPERATOR_ID", operatorKeyEnv: "SOLO_OPERATOR_KEY" };
    await writeFile(file, stringify({ ...original, network }));
    await assert.rejects(recoveryConfig(["--local", file], { env }), /SOLO_OPERATOR_ID/);
    const result = await recoveryConfig(["--local", file], { env: { SOLO_OPERATOR_ID: "0.0.2", SOLO_OPERATOR_KEY: "placeholder" } });
    assert.deepEqual(result.operatorVariables, ["SOLO_OPERATOR_ID", "SOLO_OPERATOR_KEY"]);
    assert.deepEqual(result.config, network);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** Three explicit phases: before (paid), repair (coding agent only), after (paid).
 * Re-deploy the rebuilt immutable app between repair and after. No signing keys
 * are given to the builder. Saved capabilities and raw model output stay ignored. */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { runPurchaser } from "../dist/verification/agent.js";
import { fingerprint } from "../dist/verification/engine.js";
import { loadConfig } from "../dist/verification/cli.js";
import { runScenario } from "../dist/lab/runner.js";
import { loadScenario } from "../dist/lab/schema.js";
const exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
    // Non-interactive Codex can append piped input even with a positional prompt.
    // All commands in this driver have complete arguments and require immediate EOF.
    child.stdin?.end();
  });
const phase = process.argv[2];
const root = path.resolve(
  process.env.GRANT_DEMO_OUTPUT ?? ".harness/runs/grant-flow-hosted",
);
const app = path.resolve("examples/grant-flow");
const base = process.env.VERIFIER_URL ?? "http://127.0.0.1:4320";
const json = async (f) => JSON.parse(await readFile(f, "utf8"));
const save = async (f, v) =>
  writeFile(root + "/" + f, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
async function manifest() {
  const m = {};
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if ([".harness", ".git", "node_modules"].includes(e.name)) continue;
      const f = path.join(d, e.name);
      if (e.isSymbolicLink()) throw Error("No symlinks");
      if (e.isDirectory()) await walk(f);
      else
        m[path.relative(app, f)] = createHash("sha256")
          .update(await readFile(f))
          .digest("hex");
    }
  }
  await walk(app);
  return m;
}
async function api(route, token, method = "GET", body) {
  const r = await fetch(base + route, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const b = await r.json();
  if (!r.ok) throw Error(b.error ?? String(r.status));
  return b;
}
const builderEnv = Object.fromEntries(
  ["PATH", "HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "LANG", "TMPDIR"]
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
if (phase === "before") {
  await mkdir(path.dirname(root), { recursive: true });
  await mkdir(root, { recursive: false, mode: 0o700 });
  const localScenario = path.join(app, "scenarios/simulated.yaml");
  const prepared = await loadScenario(localScenario);
  assert.equal(prepared.scenario.network.mode, "simulated");
  assert.equal(prepared.scenario.server, undefined);
  await exec(process.execPath, ["build-plan.mjs"], {
    cwd: app,
    env: builderEnv,
  });
  const baseline = await runScenario({
    file: localScenario,
    workspace: app,
    outputDirectory: root + "/simulated-before",
    prepared: { ...prepared, file: localScenario },
  });
  assert.equal(
    baseline.passed,
    false,
    "The before phase requires the controlled failing seed; refusing to buy a passing baseline",
  );
  const admin = (await readFile("/dev/stdin", "utf8")).trim();
  const catalog = await api("/catalog", admin);
  assert.equal(catalog.paymentMode, "testnet");
  assert.equal(
    catalog.packs.find((p) => p.id === "grant-distribution").availability
      .available,
    true,
  );
  const syntax = await exec(
    process.execPath,
    ["--check", "grant-service.mjs"],
    { cwd: app, env: builderEnv },
  );
  const ordinary = await exec(
    process.execPath,
    ["--test", "--test-reporter=tap", "test/application.test.mjs"],
    { cwd: app, env: builderEnv },
  );
  await writeFile(root + "/ordinary-before.tap", ordinary.stdout);
  await save("manifest-before.json", await manifest());
  await writeFile(
    root + "/before-service.mjs",
    await readFile(app + "/grant-service.mjs"),
  );
  await writeFile(
    root + "/before-plan.json",
    await readFile(app + "/payout-plan.json"),
  );
  const mandate = await api("/mandates", admin, "POST", {
    target: catalog.target,
    revision: "grant-flow-controlled-repair",
    required: ["grant-distribution"],
    ceiling: "2000000",
    executionEnvironments: ["testnet"],
    executionCeilings: { testnet: "6200000000" },
  });
  await save("capability.json", mandate);
  await purchase(mandate, false);
} else if (phase === "repair") {
  const before = await json(root + "/before.json");
  const initial = await json(root + "/manifest-before.json");
  assert.deepEqual(
    await manifest(),
    initial,
    "Workspace changed before builder",
  );
  const failures = before.job.report.runs.flatMap((r) =>
    r.report.events.filter((e) => e.status === "failed"),
  );
  const prompt =
    "Repair grant-service.mjs using the independent verifier findings below. Edit ONLY grant-service.mjs. Do not edit tests, grants.json, scenarios, catalog, README or generated payout-plan.json, and do not add files. Each grant must reach its approved recipient with its approved amount even when directory order differs from grant order. Inspect the application and input, fix the implementation, and run the existing application tests. No package installation, wallet access or live network requests. Finish with a short explanation.\n" +
    JSON.stringify(failures);
  await writeFile(root + "/builder-prompt.txt", prompt);
  const result = await exec(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-C",
      app,
      prompt,
    ],
    { env: builderEnv, timeout: 180000, maxBuffer: 4000000 },
  );
  await writeFile(root + "/builder-output.jsonl", result.stdout, {
    mode: 0o600,
  });
  await writeFile(root + "/builder-stderr.log", result.stderr, { mode: 0o600 });
  const after = await manifest();
  const edits = [
    ...new Set([...Object.keys(initial), ...Object.keys(after)]),
  ].filter((k) => initial[k] !== after[k]);
  assert.deepEqual(edits, ["grant-service.mjs"]);
  await exec(process.execPath, ["build-plan.mjs"], {
    cwd: app,
    env: builderEnv,
  });
  const ordinary = await exec(
    process.execPath,
    ["--test", "--test-reporter=tap", "test/application.test.mjs"],
    { cwd: app, env: builderEnv },
  );
  await writeFile(root + "/ordinary-after.tap", ordinary.stdout);
  const sim = await exec(
    process.execPath,
    [
      "dist/index.js",
      "lab",
      "run",
      "examples/grant-flow/scenarios/simulated.yaml",
      "--workspace",
      app,
      "--output",
      root + "/simulated-after",
    ],
    { env: builderEnv },
  );
  await save("manifest-after.json", await manifest());
  await writeFile(
    root + "/after-service.mjs",
    await readFile(app + "/grant-service.mjs"),
  );
  await writeFile(
    root + "/after-plan.json",
    await readFile(app + "/payout-plan.json"),
  );
  await save("repair.json", {
    builder: "codex",
    allowedEdits: edits,
    generatedArtifact: "payout-plan.json",
    protectedFilesUnchanged: true,
    ordinaryTestsPassed: true,
    independentSimulationPassed: true,
  });
  console.log(
    "Coding agent repaired only grant-service.mjs; unchanged ordinary tests and independent simulation pass. Build/deploy the repaired image before running after.",
  );
} else if (phase === "after") {
  assert.deepEqual(
    await manifest(),
    await json(root + "/manifest-after.json"),
    "Repaired artifact changed before retest",
  );
  await purchase(await json(root + "/capability.json"), true);
} else
  throw Error("Usage: node scripts/grant-flow-demo.mjs before|repair|after");
async function purchase(mandate, expected) {
  if (!process.env.HEDERA_OPERATOR_ID || !process.env.HEDERA_OPERATOR_KEY)
    throw Error("Client testnet payer credentials required");
  const registered = (await loadConfig(path.join(app, "catalog.json")))
    .packs[0];
  const expectedArtifact = await fingerprint(registered);
  const events = [];
  const result = await runPurchaser(base, mandate.mandateId, mandate.token, {
    pay: true,
    planner: "policy",
    repetitions: 2,
    allocation: "1000000",
    accountId: process.env.HEDERA_OPERATOR_ID,
    privateKey: process.env.HEDERA_OPERATOR_KEY,
    onEvent: (e) => {
      if (
        e.quote &&
        e.quote.artifacts["grant-distribution"] !== expectedArtifact
      )
        throw Error(
          "Hosted artifact differs from local approved build; deploy it before paying",
        );
      events.push(e);
      console.log(
        JSON.stringify({
          type: e.type,
          price: e.quote?.price,
          state: e.job?.state,
          passed: e.job?.report?.passed,
        }),
      );
    },
  });
  await save(expected ? "after.json" : "before.json", result);
  await save(expected ? "events-after.json" : "events-before.json", events);
  assert.equal(result.job.state, "complete");
  assert.equal(result.job.report.passed, expected);
  assert.equal(result.job.report.worker.transport, "private-unix-socket");
  assert.equal(result.job.report.funding[0].status, "reconciled");
  if (!expected)
    assert(
      result.job.report.runs[0].report.events.some(
        (e) => e.id === "alice-approved-amount" && e.status === "failed",
      ),
    );
  const view = await api("/mandates/" + mandate.mandateId, mandate.token);
  await save("view.json", view);
  assert.equal(view.budget.spent, expected ? "2000000" : "1000000");
  console.log(
    JSON.stringify({
      output: root,
      expectedPass: expected,
      passed: result.job.report.passed,
      transaction: result.job.transaction,
      spentTinybar: view.budget.spent,
      funding: result.job.report.funding.map(({ transactions, ...f }) => f),
    }),
  );
}

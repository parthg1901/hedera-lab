/** Actual upstream and Lab session runners; same builder, semantic validator and task inputs. */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { stringify } from "yaml";
import { createHash } from "node:crypto";
import { runScenario } from "../dist/lab/runner.js";
const exec = promisify(execFile),
  root = process.cwd();
const out = path.resolve(
  process.argv[2] ?? ".harness/runs/harness-comparison-v3",
);
const upstream = out + "/upstream";
const cases = [
  "purchase",
  "delayed-mirror",
  "wallet-rejection",
  "double-purchase",
];
const suites = [
  "purchase-replay",
  "checkin-replay",
  "concurrent-purchase",
  "timeout-recovery",
];
const hash = (s) => createHash("sha256").update(s).digest("hex");
const env = {};
for (const k of [
  "PATH",
  "HOME",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "LANG",
  "TMPDIR",
  "PLAYWRIGHT_BROWSERS_PATH",
])
  if (process.env[k]) env[k] = process.env[k];
const original = await readFile(
  "test/fixtures/harness-comparison/ticket-service.mjs",
  "utf8",
);
const tasks = [
  {
    id: "fresh",
    source:
      "export function createTicketService(ledger) { return { async handle(action) { return {ok:false,message:'Not implemented'}; } }; }\n",
    kind: "natural generation from stub",
  },
  {
    id: "legacy",
    source: original
      .replace(
        "const association = await execute({ type: 'associate', actor: 'customer', token: 'ticket' });",
        "const association = { status: 'SUCCESS' };",
      )
      .replace(
        "const tx = await execute({ type: 'submitMessage', actor: 'customer', topic: 'attendance', message: 'ticket:1:customer' });",
        "const tx = { status: 'SUCCESS', transactionId: 'invented' };",
      ),
    kind: "controlled missing association and fake attendance defects",
  },
  {
    id: "reliability",
    source: original.replace(
      "purchaseUncertain = true;",
      "purchaseUncertain = false;",
    ),
    kind: "controlled lost-response recovery defect",
  },
];
for (const task of tasks.filter((t) => t.id !== "fresh")) {
  if (task.source === original)
    throw Error("Frozen controlled mutation did not apply: " + task.id);
}
const brief = `Implement or repair ticket-service.mjs for this ticket app. Export createTicketService(ledger) returning {handle(action)}; actions are buy and check-in. Match the UI texts in index.html and scenarios. Associate the customer before transferring NFT ticket serial 1 from organizer. Check-in must submit the real HCS message ticket:1:customer to attendance. A successful consensus receipt remains success when mirror data lags. Declined signing must not change ownership. Repeated or concurrent purchases and check-ins must not duplicate successful ledger effects. After a lost successful transfer response, a retry must recover ownership before resubmitting. The ledger adapter accepts /execute operations and /observe ownership queries; examples are in scenarios. This is an in-memory single-process exercise, not a production wallet. You may edit ONLY ticket-service.mjs and optionally add self-test.mjs. Do not edit server, development adapter, scenarios, requirements or verification files. You may inspect them and run your own tests. Both syntax and a real browser semantic validator will check the app. Further independent grading will check ledger outcomes and reliability. No external networks, wallet credentials or dependencies are required. Do not inspect parent directories or other experiment runs.`;
await mkdir(out, { recursive: true });
await writeFile(
  out + "/protocol.json",
  JSON.stringify(
    {
      registeredAt: new Date().toISOString(),
      upstreamCommit: "e045b10",
      tasks: tasks.map((t) => ({
        ...t,
        source: undefined,
        seedHash: hash(t.source),
      })),
      brief,
      arms: ["upstream", "lab"],
      maxAttempts: 3,
      cases,
      suites,
      notes:
        "Same common syntax, browser smoke and real Codex Playwright semantic validation. Lab additionally gates four ledger scenarios. Final grader runs all eight suites with fresh fixtures. Sequential alternating arm order. One run per task/arm; all failures retained. Shared installed dependencies. All ledger execution simulated, no payments.",
    },
    null,
    2,
  ),
  { flag: "wx" },
);
const results = [];
for (let i = 0; i < tasks.length; i++)
  for (const arm of i % 2 ? ["lab", "upstream"] : ["upstream", "lab"]) {
    const task = tasks[i],
      dir = out + "/" + task.id + "-" + arm,
      ws = dir + "/workspace";
    await mkdir(ws, { recursive: true });
    await cp(root + "/examples/lab-ticketing", ws, {
      recursive: true,
      filter: (p) => !p.includes("/.harness"),
    });
    await writeFile(ws + "/ticket-service.mjs", task.source);
    // Both arms get the same functioning development ledger for browser checks.
    await writeFile(
      ws + "/development-ledger.mjs",
      `import {SimulatedLedger} from ${JSON.stringify(root + "/dist/lab/simulated.js")};
const ledger=new SimulatedLedger({mirrorDelayMs:0,rejectActors:[]});
await ledger.provision({accounts:{organizer:{hbar:100},customer:{hbar:10}},tokens:{ticket:{treasury:'organizer',supply:1}},topics:['attendance']});
export const developmentLedger=(route,op)=>route==='/observe'?ledger.observe(op):ledger.execute(op);
export const evidence=async()=>({ownership:await ledger.observe({type:'nftOwner',token:'ticket',serial:1,account:'customer'}),attendance:await ledger.observe({type:'topicMessage',topic:'attendance',message:'ticket:1:customer'})});
`,
    );
    let server = await readFile(ws + "/server.mjs", "utf8");
    server =
      "import {developmentLedger,evidence} from './development-ledger.mjs';\n" +
      server
        .replace(
          "if (!bridge || !token) throw new Error('Start this test app through hedera-harness lab run');",
          "",
        )
        .replace(
          "const ledger = async (route, operation) => {",
          "const ledger = async (route, operation) => {\n  if (!bridge || !token) return developmentLedger(route, operation);",
        )
        .replace(
          "  if (req.method === 'GET' && req.url === '/') {",
          "  if (req.method === 'GET' && req.url === '/favicon.ico') {res.writeHead(204).end();return;}\n  if (req.method === 'GET' && req.url === '/api/evidence') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await evidence()));return;}\n  if (req.method === 'GET' && req.url === '/') {",
        );
    await writeFile(ws + "/server.mjs", server);
    await mkdir(ws + "/.harness/validators", { recursive: true });
    await writeFile(
      ws + "/package.json",
      JSON.stringify({
        name: "harness-comparison",
        version: "1.0.0",
        type: "module",
        scripts: { build: "node --check ticket-service.mjs" },
      }),
    );
    await writeFile(ws + "/.gitignore", ".harness/runs/\n.harness/runtime/\n");
    await writeFile(ws + "/.harness/prd.md", brief);
    await writeFile(
      ws + "/.harness/validators/static.json",
      JSON.stringify({
        fileAssertions: {
          required: ["server.mjs", "ticket-service.mjs", "index.html"],
        },
      }),
    );
    await writeFile(
      ws + "/.harness/validators/yarn.json",
      JSON.stringify({
        commands: [
          { name: "install", command: "node --version" },
          { name: "build", command: "npm run build" },
        ],
      }),
    );
    await writeFile(
      ws + "/.harness/validators/playwright.yaml",
      stringify({
        name: "common-smoke",
        server: {
          command: "node server.mjs",
          url: "http://127.0.0.1:0",
          timeoutMs: 30000,
        },
        routes: [{ name: "home", path: "/" }],
      }),
    );
    await writeFile(
      ws + "/.harness/acceptance-contract.json",
      JSON.stringify({
        assertions: [
          {
            id: "C1",
            statement:
              "Use real browser actions: buy the ticket (#buy), wait for Ticket purchased in #status, then check in (#check-in), wait for Checked in. Fetch /api/evidence from the browser: ownership.matches and attendance.matches must both be true. UI text alone is insufficient. Repeat buy and check-in and verify they still succeed.",
            route: "/",
            severity: "critical",
          },
        ],
      }),
    );
    const spec = {
      schemaVersion: 2,
      name: "harness-comparison",
      agent: "claude",
      skills: [],
      contract: ".harness/acceptance-contract.json",
      generator: {
        command: "codex",
        args: [
          "exec",
          "--ephemeral",
          "--json",
          "--sandbox",
          "workspace-write",
          "{prompt}",
        ],
        timeoutMs: 600000,
      },
      validator: {
        enabled: true,
        command: "node",
        args: [root + "/scripts/harness-eval-validator.mjs", "{prompt}"],
        timeoutMs: 270000,
      },
      validators: {
        static: ".harness/validators/static.json",
        commands: ".harness/validators/yarn.json",
        playwright: ".harness/validators/playwright.yaml",
      },
      constraints: { packageManager: "npm" },
      baseline: {
        commands: [
          { name: "install", command: "node --version" },
          { name: "build", command: "npm run build" },
        ],
      },
      maxAttempts: 3,
      ...(arm === "lab"
        ? { lab: { scenarios: cases.map((n) => "scenarios/" + n + ".yaml") } }
        : {}),
    };
    await writeFile(ws + "/.harness/spec.yaml", stringify(spec));
    for (const a of [
      ["init", "-q", "-b", "main"],
      ["config", "user.name", "Lab Evaluation"],
      ["config", "user.email", "eval@example.invalid"],
      ["add", "."],
      ["commit", "-qm", "Frozen comparison task"],
    ])
      await exec("git", a, { cwd: ws });
    console.log("START " + task.id + " " + arm);
    const start = Date.now();
    let executionError;
    try {
      const r = await exec(
        "node",
        [
          root + "/scripts/harness-comparison-worker.mjs",
          arm === "lab" ? root : upstream,
          ws,
          dir + "/session.json",
        ],
        { env, timeout: 1800000, maxBuffer: 12000000 },
      );
      await writeFile(dir + "/session.log", r.stdout + "\n" + r.stderr);
    } catch (e) {
      executionError = e.message;
      await writeFile(
        dir + "/session.log",
        (e.stdout ?? "") + "\n" + (e.stderr ?? ""),
      );
    }
    let session;
    try {
      session = JSON.parse(await readFile(dir + "/session.json", "utf8"));
    } catch {}
    const { stdout: changed } = await exec(
      "git",
      ["diff", "main", "--name-only"],
      { cwd: ws },
    );
    const { stdout: untracked } = await exec(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: ws },
    );
    const unexpectedFiles = (changed + "\n" + untracked)
      .trim()
      .split("\n")
      .filter((f) => f && !["ticket-service.mjs", "self-test.mjs"].includes(f));
    const { stdout: diff } = await exec(
      "git",
      ["diff", "main", "--", "ticket-service.mjs"],
      { cwd: ws },
    );
    await writeFile(dir + "/repair.diff", diff);
    const grade = [];
    for (const name of cases) {
      try {
        const r = await runScenario({
          file: ws + "/scenarios/" + name + ".yaml",
          workspace: ws,
          outputDirectory: dir + "/grade/" + name,
        });
        grade.push({
          name,
          passed: r.passed,
          infrastructureFailure: r.infrastructureFailure,
        });
      } catch (e) {
        grade.push({ name, passed: false, error: e.message });
      }
    }
    for (const name of suites) {
      try {
        const r = await exec(
          "node",
          [root + "/dist/verification/protocol-worker.js", name, ws],
          { env, timeout: 60000, maxBuffer: 1000000 },
        );
        await writeFile(dir + "/" + name + ".json", r.stdout);
        const report = JSON.parse(r.stdout);
        grade.push({ name, passed: report.passed, events: report.events });
      } catch (e) {
        await writeFile(dir + "/" + name + ".json", e.stdout ?? "");
        let report;
        try {
          report = JSON.parse(e.stdout);
        } catch {}
        grade.push({
          name,
          passed: false,
          events: report?.events,
          error: report ? undefined : e.message,
        });
      }
    }
    const r = {
      task: task.id,
      arm,
      durationMs: Date.now() - start,
      executionError,
      harnessPassed: session?.report.passed,
      attempts: session?.report.attempts,
      semanticPassed: session?.report.semanticValidation?.passed,
      unexpectedFiles,
      grade,
      independentPassed:
        unexpectedFiles.length === 0 && grade.every((g) => g.passed),
    };
    results.push(r);
    await writeFile(
      out + "/summary.json",
      JSON.stringify({ complete: results.length === 6, results }, null, 2),
    );
    console.log(JSON.stringify(r));
  }

/** Export an explicit allowlist of evidence; never copy capabilities or raw state. */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
const source = path.resolve(
  process.argv[2] ?? ".harness/runs/grant-flow-hosted",
);
const out = path.resolve(process.argv[3] ?? path.join(source, "published"));
await mkdir(out, { recursive: true });
for (const file of [
  "before.json",
  "after.json",
  "before-service.mjs",
  "after-service.mjs",
  "before-plan.json",
  "after-plan.json",
  "ordinary-before.tap",
  "ordinary-after.tap",
  "manifest-before.json",
  "manifest-after.json",
  "repair.json",
  "independent-mirror.json",
  "onboarding.json",
  "events-before.json",
  "events-after.json",
  "before-desktop.png",
  "after-desktop.png",
  "before-mobile.png",
  "after-mobile.png",
  "before-dashboard.json",
  "after-dashboard.json",
])
  await copyFile(source + "/" + file, out + "/" + file);
await copyFile(
  source + "/simulated-after/report.json",
  out + "/simulated-after.json",
);
const rows = (await readFile(source + "/builder-output.jsonl", "utf8"))
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const builder = {
  tool: "Codex CLI",
  model: "Configured default; not a controlled model comparison",
  firstInvocation: {
    outcome: "No edits; rejected by scope audit",
    cause: "stdin pipe was left open; original logs retained privately",
  },
  successfulInvocation: {
    completed: rows.some((r) => r.type === "turn.completed"),
    usage: rows.find((r) => r.type === "turn.completed")?.usage,
    finalMessage: rows
      .filter((r) => r.item?.type === "agent_message")
      .at(-1)
      ?.item.text.replaceAll(process.cwd(), "<checkout>"),
  },
  walletEnvironmentForwarded: false,
};
await writeFile(
  out + "/builder-summary.json",
  JSON.stringify(builder, null, 2) + "\n",
);
const evidence = JSON.parse(await readFile(out + "/independent-mirror.json"));
const before = await readFile(out + "/before-service.mjs", "utf8");
const after = await readFile(out + "/after-service.mjs", "utf8");
const escape = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const hbar = (n) => (Number(n) / 1e8).toFixed(8);
const paymentLinks = evidence.runs
  .map(
    (r) =>
      `<li>${escape(r.phase)}: <a href="https://hashscan.io/testnet/transaction/${encodeURIComponent(r.paymentTransaction)}">${escape(r.paymentTransaction)}</a></li>`,
  )
  .join("");
await writeFile(
  out + "/index.html",
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GrantFlow — paid verification and repair</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f7f4;color:#213a31;font:16px/1.55 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:36px 20px}h1{font-size:clamp(30px,5vw,48px);line-height:1.1}h2{font-size:23px}.eyebrow{font-size:12px;letter-spacing:.1em;font-weight:700}.lead{max-width:780px;color:#52665c}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.card,section{background:white;border:1px solid #dce5dd;border-radius:12px;padding:22px;margin:20px 0}.grid .card{margin:0}.pass{color:#176746}.fail{color:#a53a2a}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px 8px;border-bottom:1px solid #e4eae4}a{color:#176746;overflow-wrap:anywhere}pre{background:#f1f4f0;padding:15px;overflow:auto;font-size:12px}.note{font-size:14px;color:#53645a}.flow{font-size:18px;font-weight:600}img{max-width:100%;height:auto}code{overflow-wrap:anywhere}@media(max-width:650px){.grid{grid-template-columns:minmax(0,1fr)}main{padding:22px 12px}td,th{padding:9px 4px;font-size:13px}section,.card{padding:16px}}
</style><main><div class="eyebrow">HEDERA LAB · REAL TESTNET · CONTROLLED DEFECT</div><h1>A correct payout total.<br>The wrong recipients.</h1><p class="lead">The application's four existing tests passed. Purchased verification executed its prepared HBAR transactions and independently found the wrong recipient amounts. A coding agent repaired the source, and a fresh paid retest passed under the same mandate.</p><p class="flow">Quote → pay → fail → agent repair → fresh quote → pay → pass</p><div class="grid"><div class="card"><h2 class="fail">Before repair: FAIL</h2><p>Ordinary application tests: <strong>4/4 pass</strong>.</p><p>Alice received 0.25 HBAR; Bob received 0.75 HBAR. The total was still the expected 1 HBAR.</p></div><div class="card"><h2 class="pass">After repair: PASS</h2><p>The same application tests: <strong>4/4 pass</strong>.</p><p>Alice received her approved 0.75 HBAR; Bob received his approved 0.25 HBAR. Protected inputs and scenarios were unchanged.</p></div></div><section><h2>Independent mirror evidence</h2><table><tr><th>Recipient</th><th>Approved</th><th>Before</th><th>After</th></tr><tr><td>Alice</td><td>0.75 HBAR</td><td class="fail">0.25 HBAR</td><td class="pass">0.75 HBAR</td></tr><tr><td>Bob</td><td>0.25 HBAR</td><td class="fail">0.75 HBAR</td><td class="pass">0.25 HBAR</td></tr></table><p>Both settlements independently confirmed. One batch message per run. All six disposable accounts and both topics deleted.</p><p><a href="independent-mirror.json">Inspect independent transfer and cleanup evidence</a></p></section><section><h2>Payment and testing funds</h2><p><strong>0.02 testnet HBAR total service payment</strong>: two 0.01 HBAR requests. The failed check was a delivered, paid result.</p><p>Actual provider execution fees: ${hbar(evidence.runs.reduce((s, r) => s + BigInt(r.actualFeeTinybar), 0n))} testnet HBAR across both runs. A 62 HBAR execution exposure ceiling authorized both runs; it was not a customer bill.</p><ul>${paymentLinks}</ul><p class="note">Testing funds are separate from service payment. Recovered fixture balances and actual fees are in each report; fixture-paid fees must not be counted twice.</p></section><section><h2>The agent's source repair</h2><p>Use the grant's explicit recipient rather than its position in the directory. Only <code>grant-service.mjs</code> was edited by the agent; the evaluator regenerated the JSON plan.</p><div class="grid"><div><h3>Before</h3><pre>${escape(before)}</pre></div><div><h3>After</h3><pre>${escape(after)}</pre></div></div><p><a href="builder-summary.json">Builder record</a> · <a href="repair.json">Edit-scope audit</a> · <a href="manifest-before.json">Before hashes</a> · <a href="manifest-after.json">After hashes</a></p></section><section><h2>Review and reproduce</h2><ul><li><a href="before.json">Paid failing report</a> and <a href="after.json">paid passing report</a></li><li><a href="after-desktop.png">Actual hosted dashboard</a> and <a href="after-mobile.png">mobile view</a></li><li><a href="onboarding.json">Clean-copy onboarding results</a></li><li><a href="../../../../examples/grant-flow/README.md">Second-app onboarding guide</a></li><li><a href="README.md">Complete method and reproduction</a></li></ul><p class="note">This is a seeded defect and a specific gap in the supplied tests. Stronger recipient-order tests could also catch it. It does not establish a natural model-defect rate or general superiority. The worker executes validated inert plans, not arbitrary application code. The deployment is private; a public HTTPS endpoint and narrated submission video remain separate deliverables.</p></section></main></html>`,
);
console.log(out + "/index.html");

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { MainnetMirror } from "../dist/preflight/mirror.js";
import { verifyApproval } from "../dist/preflight/verify.js";
import { digest } from "../dist/preflight/model.js";
const output = path.resolve(
  process.argv[2] ?? ".harness/runs/preflight-" + Date.now(),
);
await mkdir(output, { recursive: true });
const protocol = JSON.parse(
  await readFile("examples/preflight/evaluation.json", "utf8"),
);
await writeFile(
  output + "/protocol.json",
  JSON.stringify(
    {
      registeredAt: new Date().toISOString(),
      protocolHash: digest(protocol),
      ...protocol,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
const mirror = new MainnetMirror(),
  snapshot = await mirror.snapshot();
const corpus = {
  schemaVersion: 1,
  scope:
    "Constructed approval proposals; transient mainnet mirror execution; no signed transaction or funds moved.",
  protocolHash: digest(protocol),
  snapshot,
  policy: protocol.policy,
  abi: [
    {
      type: "function",
      name: "approve",
      stateMutability: "nonpayable",
      inputs: [
        { name: "spender", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      outputs: [{ name: "", type: "bool" }],
    },
  ],
  entries: [],
};
for (const c of protocol.cases) {
  let simulation, estimate, error;
  try {
    simulation = await mirror.call(c.proposal, snapshot);
    estimate = await mirror.call(c.proposal, snapshot, true);
  } catch (e) {
    error = e.message;
  }
  const lab =
    simulation && estimate && !error
      ? verifyApproval(
          protocol.policy,
          c.proposal,
          snapshot,
          simulation,
          estimate,
        )
      : null;
  corpus.entries.push({
    ...c,
    simulation,
    estimate,
    lab,
    ...(error ? { error } : {}),
  });
  await writeFile(output + "/corpus.json", JSON.stringify(corpus, null, 2));
  console.log(
    JSON.stringify({
      case: c.id,
      expected: c.expected,
      http: simulation?.httpStatus,
      rawSuccess: simulation?.httpStatus === 200,
      lab: lab?.decision,
      error,
    }),
  );
}
console.log(output);

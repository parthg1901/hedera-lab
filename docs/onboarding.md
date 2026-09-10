# Bring your payout application to Lab

The onboarding wizard connects a local JavaScript payout function to independent
verification. You supply the approved recipient amounts; it generates the adapter,
fixtures, simulated/testnet scenarios, readable contract, and provider handoff.
You do not write YAML or decide provider prices.

## Have an agent do the integration

Give the agent [the Hedera Lab skill](../skills/hedera-lab/SKILL.md). It explains
how to connect real application logic, generate custom NFT/HCS plans or browser
bindings when the payout wizard is insufficient, and keep acceptance requirements
independent. The agent writes the Lab files; you supply the intended behavior and
any live spending authorization. This does not add new operations to the runner or
automatically register your application with a hosted provider.

## First verification

From a built Hedera Lab checkout:

```sh
node dist/index.js lab onboard inspect --workspace /path/to/your-app
node dist/index.js lab onboard init --workspace /path/to/your-app
```

Inspection reads bounded source files for export declarations; it does not import
code or install dependencies. The interactive wizard offers candidate entry files,
exports and JSON inputs. Review the selection: discovery is a heuristic, not
semantic understanding of your project.

The selected function receives one parsed JSON argument and may return a promise.
The first supported shape is an array of exact `{recipient, amount}` objects:

```js
export function payouts(batch) {
  return batch.approvals.map(item => ({
    recipient: item.name,
    amount: item.approvedHbar,
  }));
}
```

Alternatively select `plan` for a Lab JSON plan containing only HBAR transfers from
the selected payer. There may be 1–20 operations. Compile TypeScript first; for
SDK transaction objects, other runtimes or different return shapes, expose a small
pure wrapper around the real business logic. Do not hardcode a correct plan while
leaving the application disconnected. The wizard reports unsupported shapes;
it does not pretend to adapt arbitrary applications.

Enter the approved payouts, for example `alice=0.75,bob=0.25`. These are requirements,
not predictions extracted from the implementation. Each recipient fixture starts
with 1 HBAR; Lab checks its final balance against 1 plus its approved payout.
Fixture aliases replace real account IDs. The payer fixture receives the approved
total plus 1 HBAR; provider fee estimates are configured separately at registration.

The last prompt asks to execute your selected application locally. This is trusted
local code execution, **not a sandbox**: it can access your filesystem and network.
The subprocess has a 15-second bound and a minimal environment without inherited
wallet/provider/cloud/model credentials, but that does not stop code reading files.
No dependency installation or wallet is needed for the free simulated run.

## Generated files and review

```text
verification/
├── onboarding.json           # Function/input binding and customer expectations
├── build-plan.mjs            # Generated local adapter; review this connection
├── payout-plan.json          # Actual application output
├── scenarios/
│   ├── simulated.yaml
│   └── testnet.yaml
├── CONTRACT.md               # Human-readable behavior and scope
├── provider-handoff.json     # Registration request, with no invented price
├── ADAPTER.md                # Supported shapes and troubleshooting
├── approval.json             # Local review hash, created by approve; ignored
├── last-run.json              # Latest result link and entry/input hashes; ignored
└── runs/                     # Local JSON/HTML evidence; ignored
```

Read `CONTRACT.md`, the adapter, and the assertions. Record that review explicitly:

```sh
node dist/index.js lab onboard approve --workspace /path/to/your-app
node dist/index.js lab onboard check --workspace /path/to/your-app --allow-execution
```

`check` rebuilds from the current application and current input. It validates the
complete plan before replacing the previous one, then reruns the original checks.
Changed requirements, adapter, bindings, scenarios or handoff block execution until
reviewed again. Extra or missing operations require revisiting scenario coverage.
Ordinary source fixes can be retested without weakening the agreed amounts.

The review hash is a local change detector, not a cryptographic customer identity
or a defense against arbitrary malicious code running with your own user access.
If requirements intentionally change, inspect the diff, remove your local
`verification/approval.json`, and explicitly approve again. `approve` never
silently replaces a previous approval. `init` never overwrites an existing folder;
on an initial build error, diagnostics and draft files remain for inspection.

## Coding-agent / noninteractive use

A coding agent can call the same CLI; no model account or vendor-specific plugin
is required. Supply flags instead of answering prompts:

```sh
node dist/index.js lab onboard init \
  --workspace /path/to/your-app \
  --entry src/payouts.mjs --export payouts --input examples/batch.json \
  --format transfers --actor treasury \
  --expect alice=0.75,bob=0.25 --allow-execution
```

Do not have the coding agent derive `--expect` from the generated plan. Obtain
requirements from the customer and keep unsupported assumptions explicit.
A failure exits 1 and prints the failed assertion and HTML report path. A passing
simulation exits 0 and remains labeled simulated. No automatic live payment occurs.

## From local checks to a paid service

The provider receives `provider-handoff.json` and reviews the source/input/adapter
connection. It chooses prices and execution funding ceilings and registers the
project root as workspace, with `verification/scenarios/testnet.yaml` as scenario.
The project root includes the application source and inputs as well as generated
plans; these must be immutable and match between API and worker. Omit local
`verification/runs`, `approval.json` and `last-run.json` when preparing the frozen
provider workspace. Do not register
only the plan folder and lose the application-source binding.

The worker receives bounded JSON operations, never imports application modules,
and never runs the local build script. A customer then approves a mandate and a
fresh quote through the existing dashboard/purchasing-agent flow. Current hosted
registration remains operator-managed. This wizard does not upload repositories,
automatically deploy a provider, or turn a simulation into testnet evidence.

For your own funded testnet account, the ordinary `lab run` command can execute
the generated testnet scenario using the project root as `--workspace`. That is
separate from buying a provider service. No Solo scenario is synthesized because
its real endpoint configuration must come from the user's deployment.

## What this verifies

This release checks final HBAR recipient balances for a supplied input. It does
not automatically cover UI, authentication, duplicate payments across retries,
HTS/HCS workflows, smart contracts, arbitrary repositories or every application
input. Those need other protected scenarios or adapters. A simulation pass is
only simulator evidence.

See [Team payouts](../examples/team-payouts/README.md) for a clean project with no
Lab files and [the onboarding evaluation](results.md) for measured
manual work, failure cases and limitations.

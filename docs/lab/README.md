# Hedera Lab

For application-generated transaction plans, see the [plan reference](../reference/application-plans.md) and [GrantFlow onboarding example](../../examples/grant-flow/README.md).

Hedera Lab adds executable Hedera scenarios to the harness. A scenario provisions
fresh accounts, NFT tokens and consensus topics; drives SDK operations or a real
browser; asserts network state; and writes a portable HTML/JSON evidence report.
In `hedera-harness run`, failed scenarios feed the existing coding-agent repair loop.

## Try it

From this repository (Node >=20):

```sh
npm ci
npm run build
node dist/index.js lab run examples/lab-ticketing/scenarios/ledger.yaml
```

The ledger example is simulated and needs neither credentials nor a browser.
For the complete ticketing app:

```sh
npx playwright install --with-deps chromium
node dist/index.js lab doctor examples/lab-ticketing/scenarios/purchase.yaml
node dist/index.js lab run examples/lab-ticketing/scenarios/purchase.yaml \
  --workspace examples/lab-ticketing
```

Open the printed `index.html` path. Filter the transaction/assertion timeline,
expand events to inspect evidence, and open `report.json` for machine-readable data.
Reports default to `.harness/runs/lab/<UUID>/` inside the workspace. An optional
`--output <directory>` selects a report directory and replaces its two report files.

## Modes and what a pass means

| Mode | Executes | A pass establishes |
|---|---|---|
| simulated | In-memory ledger plus optional real Chromium browser | App behavior against the documented fixture model |
| local | Hiero SDK against loopback consensus and mirror endpoints | Scenario behavior on your local network |
| testnet | Hiero SDK against fixed Hedera testnet endpoints | Scenario behavior on testnet |

No fallback between modes occurs. The simulator has no network fees, cryptographic
signature verification, consensus, or SDK protocol emulation. It models explicit
association, NFT ownership, HBAR balances, messages, delayed read visibility, and
injected actor rejection. It cannot validate production wallet compatibility.

The example uses a **server-side test signer adapter**, not a wallet extension.
A loopback bridge holds the fixture keys in memory; the app server receives a
per-run bearer token in `HARNESS_LAB_TOKEN` and the endpoint in `HARNESS_LAB_URL`.
Never expose that token to client code. `GET /fixtures` returns public resource IDs;
`POST /execute` accepts scenario operation objects; `POST /observe` supports the
example's NFT ownership read. Assertions independently query the ledger.

## Scenario format

```yaml
schemaVersion: 1
name: Transfer a ticket
network:
  mode: simulated
fixtures:
  accounts:
    organizer: { hbar: 100 }
    customer: { hbar: 10 }
  tokens:
    ticket: { treasury: organizer, supply: 1 }
  topics: [attendance]
steps:
  - id: associate
    operation: { type: associate, actor: customer, token: ticket }
  - id: transfer
    operation:
      type: transferNft
      actor: organizer
      to: customer
      token: ticket
      serial: 1
  - id: ownership
    assert: { type: nftOwner, token: ticket, serial: 1, account: customer }
```

Every step has a unique `id` and exactly one `operation`, `browser`, or `assert`.
At least one assertion is mandatory. Unknown fields, missing references, invalid
amounts, duplicate IDs, and unsupported modes fail schema loading. Scenario steps
run sequentially; a failed prerequisite skips remaining steps. Expected negative
operations require an exact `expectStatus`, e.g. `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`.

Supported operations:

| Type | Fields |
|---|---|
| associate | actor, token |
| transferNft | actor, to, token, serial |
| transferHbar | actor, to, amount (HBAR) |
| submitMessage | actor, topic, message (UTF-8, <=1024 bytes) |

Supported assertions:

| Type | Fields | Evidence |
|---|---|---|
| nftOwner | token, serial, account | Mirror NFT ownership response |
| topicMessage | topic, message | Exact decoded payload in a freshly created topic |
| hbarBalance | account, min, max | Simulated balance or SDK account query; live values include fees |
| text | selector, equals | Exact trimmed DOM text |

`timeoutMs` (default 10000) bounds assertion polling and browser actions;
`pollIntervalMs` defaults to 100. A single in-flight live query has its own network
timeout and can outlast the polling deadline. Live SDK requests use a 15s request
timeout and at most two SDK attempts. These are per-request limits, not a strict
wall-clock deadline for all provisioning and cleanup operations.

Browser scenarios add a `server` block (`command`, loopback `url`, optional
`timeoutMs`). The server must print `Local: http://127.0.0.1:<port>`; an ephemeral
port is recommended. Browser steps support `goto` with an app-relative `path`,
`click` with a `selector`, and `fill` with `selector` and `value`.

Faults are explicit and simulated-only:

```yaml
faults:
  mirrorDelayMs: 700
  rejectActors: [customer]
```

A bridge transaction error is retained in the timeline even when subsequent UI
assertions prove correct recovery. Overall pass is derived from every declared
step passing, plus successful infrastructure/cleanup. This is why a passing
rejection scenario may display a failed transaction event.

## Connect to a real local network

Solo provides the network; Lab orchestrates your fixtures and assertions.
Check the current [Solo system requirements](https://solo.hiero.org/docs/simple-solo-setup/system-readiness/)
and [quickstart](https://solo.hiero.org/docs/simple-solo-setup/quickstart/).
Solo 0.88.0 requires Node >=22, Docker, at least 12 GB container memory and
6 CPU cores; reserve at least 20 GB disk. On macOS, Docker Desktop must be running.
Starting Docker can also start unrelated containers with restart policies. Check
existing resources first; changing Docker allocations requires a restart.

### Isolated laptop deployment

The following uses project-local tools and configuration. It preserves the default
Kubernetes context, which may point at a shared or production cluster. Do not use
`lab up` with an unrelated active context: the wrapper runs Solo directly and does
not isolate Kubernetes configuration for you.

```sh
npm ci
npm run build
npx playwright install chromium  # macOS; Linux may also need --with-deps
npm run lab:demo                # real browser, simulated ledger baseline

npm install --prefix .harness/runs/solo-tools --no-audit --no-fund @hiero-ledger/solo@0.88.0
export SOLO_HOME="$PWD/.harness/runs/solo-home"
export KUBECONFIG="$PWD/.harness/runs/solo-kubeconfig"
export PATH="$PWD/.harness/runs/solo-tools/node_modules/.bin:$PATH"
# First use only: never overwrite an existing cluster configuration.
if [ ! -e "$KUBECONFIG" ]; then
  printf 'apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\ncurrent-context: ""\n' > "$KUBECONFIG"
  chmod 600 "$KUBECONFIG"
fi
solo --version
solo one-shot single deploy --help
solo one-shot single deploy --deployment hedera-lab-local \
  --namespace hedera-lab-local --minimal-setup --external-address 127.0.0.1
```

Solo 0.88.0's empty-configuration path requires an existing, valid kubeconfig file;
a nonexistent path caused it to skip cluster creation and fail initialization.
Solo installs its missing Kind/Helm/crane tools under `SOLO_HOME/bin`. This setup
creates `solo-cluster` / `kind-solo-cluster`; check for an existing Kind cluster of
that name before proceeding. Inspect partial state before retrying a failed deploy:
Solo may propose replacing an existing deployment. Do not accept destruction of
unrelated resources. Keep Solo account output/private logs in the ignored workspace.

The `lab up` wrapper remains available for an already isolated shell. It checks
Docker/Solo then invokes `solo one-shot single deploy`; it does not install tools
or infer endpoint ports. Inspect the installed version's command help first.

Copy the **actual endpoints and node account reported by Solo** into both
`scenarios/local.yaml` and `scenarios/local-purchase.yaml`. Their bundled values
are gRPC `127.0.0.1:35211`, node `0.0.3`, and mirror `http://127.0.0.1:38081`.
Configure `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` from a funded **local ECDSA**
account in that deployment's private `accounts.json` output. Verify the account's
public key against the mirror. System/genesis ED25519 keys are not compatible with
the Lab adapter. Never reuse testnet credentials or paste a private key into YAML,
tracked files, shell command arguments, logs, or reports.

```sh
# Set the LOCAL operator environment privately before these commands.
node dist/index.js lab doctor examples/lab-ticketing/scenarios/local.yaml
node dist/index.js lab run examples/lab-ticketing/scenarios/local.yaml \
  --workspace examples/lab-ticketing
node dist/index.js lab run examples/lab-ticketing/scenarios/local-purchase.yaml \
  --workspace examples/lab-ticketing
node scripts/lab-recovery-eval.mjs --local examples/lab-ticketing/scenarios/local.yaml
# Linux with util-linux flock and local journal storage:
node scripts/lab-recovery-eval.mjs --local examples/lab-ticketing/scenarios/local.yaml --crash
```

Doctor checks schema, environment presence, mirror reachability, and browser launch
when needed. It does not prove operator signatures or consensus health. Require
actual fixture creation, NFT transfer, mirror ownership/HCS evidence and cleanup;
the browser scenario additionally checks purchase and check-in UI behavior.

Use targeted teardown with the **same** `SOLO_HOME` and `KUBECONFIG`:

```sh
solo one-shot single destroy --help
solo one-shot single destroy --deployment hedera-lab-local
# Only if this task created the cluster and it has no other workloads:
"$SOLO_HOME/bin/kind" delete cluster --name solo-cluster
```

Do not use broad Docker prune/reset or delete ownership guards. Preserve unfinished
Lab recovery journals until fixture cleanup is complete. See [recovery](RECOVERY.md)
for the Linux/macOS distinction and [work log](../results.md) for execution evidence.

For testnet, use `scenarios/testnet.yaml` and a funded ECDSA testnet operator.
Network-changing overrides are intentionally not implicit: the selected YAML
records exactly what backend was requested. Fault injection is rejected live.

Fresh fixtures isolate evidence from prior runs. Live cleanup deletes created
tokens/topics, dissociates deleted tokens, then deletes accounts, sweeping remaining HBAR to the operator.
Cleanup is best effort and explicitly reported; failure aborts the repair loop to
avoid creating more resources. Abrupt host termination can bypass cleanup. Live runs save disposable fixture keys
and pending creation transaction IDs in `lab-recovery.json` inside the output
directory (mode 0600). The operator key is never saved. Successful cleanup removes
this journal; failures retain it for SDK-assisted recovery. Do not publish it.
There is not yet a dedicated recovery CLI. Reusing a directory with an unfinished
journal is blocked. Keep live runs small and use a disposable operator.

The three testnet examples use 10 HBAR of total fixture funding per run, plus
operator-paid creation and cleanup fees. `testnet.yaml` exercises direct SDK
operations, `testnet-negative.yaml` verifies association rejection and recovery,
and `testnet-purchase.yaml` drives the browser against real testnet transactions.

## Add Lab to a harness recipe

```yaml
lab:
  scenarios:
    - scenarios/purchase.yaml
    - scenarios/delayed-mirror.yaml
    - scenarios/wallet-rejection.yaml
```

The harness runs Lab after deterministic checks and before optional semantic
validation. Scenario YAML is captured in memory before the coding agent runs, and
its hash is checked before validation. Editing/removing a scenario fails the gate;
the agent must repair the app. Stable scenario/step finding IDs support the existing
fixed/open finding tracking. Infrastructure failures abort instead of requesting
an app repair. Each attempt stores its own Lab reports under that run's logs.

Commands and application code are trusted developer inputs. This is validation
isolation within the harness process, not a sandbox against an agent with arbitrary
host access. The consuming app and installed harness should be separate projects.

## Put a real agent to the test

```sh
# Requires an authenticated Codex CLI; makes an isolated git repository.
node scripts/lab-agent-eval.mjs codex combined
# Or use an authenticated Claude CLI:
node scripts/lab-agent-eval.mjs claude combined
```

The experiment injects three defects into a copy of the ticketing app, runs four
browser scenarios to establish failures, then invokes the real harness repair loop.
The agent gets requirements and observed failures, never a prewritten patch. It
has three attempts. Artifacts contain the baseline, agent logs, checkpoint commits,
per-attempt scenarios, `repair.diff`, and `summary.json`. Changes outside the permitted
service file make the experiment fail even if scenarios pass. No mock is substituted
when authentication or agent execution fails.

Individual challenges: `fake-success`, `mirror-lag`, `missing-association`.
Fixture-backed regression tests are separate from this real-agent experiment.

## Verification commands

```sh
npm test
npm run test:browser
node scripts/lab-agent-eval.mjs codex combined
```

See [results](../results.md)
for measured results and limitations. Live-network results are reported only when
actually executed; SDK compilation and simulated passes do not establish parity.

## Durable transaction recovery

The bridge can persist request IDs and original transaction IDs before submission,
then reconcile lost responses after restart. The ticketing server enables this
capability automatically. See [the recovery guide](RECOVERY.md) for the demo,
API, SDK fixture reattachment, verified testnet evidence, and automatic Linux
hard-crash ownership recovery.

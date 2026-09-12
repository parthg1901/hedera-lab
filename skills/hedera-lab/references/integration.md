# Application integration reference

Use this for custom plans or browser bindings. Confirm the installed Lab schema
when extending it; the shapes below match the Hedera Lab implementation shipped
with this skill.

## Files and paths

A useful convention, not a required project reorganization:

```text
app/
├── src/                         # Actual app logic; preserve its framework
├── verification/
│   ├── input.json               # Representative input, no credentials
│   ├── build-plan.mjs           # Calls actual app logic
│   ├── plan.json                # Generated output, no executable code
│   ├── CONTRACT.md              # Approved behavior and limitations
│   └── scenarios/
│       ├── simulated.yaml
│       └── testnet.yaml
└── .harness/runs/               # Ignored reports and private recovery state
```

With `--workspace "$APP_ROOT"`, `planOperation.file` must be
`verification/plan.json`, not `plan.json`. CLI scenario arguments are resolved from
the shell's current directory. Pass absolute paths when working across checkouts.
The registered workspace should contain source and inputs as well as the plan.

## Supported schema

Plan root: exactly `{schemaVersion: 1, operations: [...]}`. Supported operations:

| type | Required fields besides type |
| --- | --- |
| `transferHbar` | `actor`, `to`, `amount` in HBAR |
| `associate` | `actor`, `token` |
| `transferNft` | `actor`, `to`, `token`, `serial` |
| `submitMessage` | `actor`, `topic`, `message` (UTF-8, at most 1024 bytes) |

`actor` and `to` refer to fixture accounts, `token` to an NFT fixture, and `topic`
to a topic fixture. Do not supply external account IDs. Every plan operation must
be referenced exactly once in scenario steps. Limits: 1–20 operations per plan,
64 KiB per plan, at most 20 plans; no symlinks, traversal paths, imports or commands.

Scenario root: `schemaVersion`, `name`, `network`, `fixtures`, `steps`; optional
`timeoutMs`, `pollIntervalMs`, simulated-only `faults` and browser `server`.
Each step has a unique `id` and exactly one `planOperation`, `operation`, `browser`
or `assert`. At least one assertion is required. Direct negative operations may
use an exact `expectStatus`; avoid unsupported assertion names.

| Assertion | Fields |
| --- | --- |
| `hbarBalance` | `account`, `min`, `max` |
| `nftOwner` | `token`, `serial`, `account` |
| `topicMessage` | `topic`, `message` |
| `text` | `selector`, `equals` (browser only) |

Accounts have `{hbar: number}`; NFT fixtures have `{treasury: accountAlias, supply:
integer}`; topics are an array of aliases. Associate the recipient before an NFT
transfer when required. Live actor balances may include fees; use independent
recipient balances or explicit bounds rather than ignoring fee semantics.

## Example: verify the application's audit message

Suppose the real application already exports `prepareAudit` from `src/audit.mjs`.
A wrapper must call that export, not reimplement the expected message.

`verification/build-plan.mjs`:

```js
import {readFile, writeFile} from 'node:fs/promises';
import {prepareAudit} from '../src/audit.mjs';
const input = JSON.parse(await readFile(new URL('./input.json', import.meta.url), 'utf8'));
const message = await prepareAudit(input);
await writeFile(new URL('./plan.json', import.meta.url), JSON.stringify({
  schemaVersion: 1,
  operations: [{type: 'submitMessage', actor: 'publisher', topic: 'audit', message}],
}, null, 2) + '\n');
```

`verification/input.json`:

```json
{"batchId":"batch-7","approvedCount":2}
```

The user requirement is the exact message `batch:batch-7:approved:2`. Encode that
requirement independently in `verification/scenarios/simulated.yaml`:

```yaml
schemaVersion: 1
name: Approved batch audit
network: {mode: simulated}
fixtures:
  accounts:
    publisher: {hbar: 5}
  tokens: {}
  topics: [audit]
steps:
  - id: publish
    planOperation: {file: verification/plan.json, index: 0}
  - id: approved-audit
    assert: {type: topicMessage, topic: audit, message: 'batch:batch-7:approved:2'}
```

```sh
node "$APP_ROOT/verification/build-plan.mjs"
node "$LAB_CLI" lab run "$APP_ROOT/verification/scenarios/simulated.yaml" \
  --workspace "$APP_ROOT"
```

This proves the message prepared for this input and its observed publication in
the selected ledger. It does not prove request authentication, replay protection
or all input combinations. Add those behaviors through appropriate app-level tests
or additional supported scenarios rather than claiming them from this one result.

For testnet, keep the assertions and fixtures and change `network.mode` to `testnet`.
For Solo, use `mode: local` plus confirmed `nodeAddress` (loopback host:port),
`nodeAccountId` and `mirrorUrl`. Never fabricate local ports. Credential environment
names may be configured with `operatorIdEnv` and `operatorKeyEnv`; values stay out
of scenarios. Check availability with `lab doctor` before authorized live execution.

## Browser binding

Use this when the request concerns actual UI or backend behavior. The app's test
server receives `HARNESS_LAB_URL`, `HARNESS_LAB_TOKEN` and `HARNESS_LAB_MODE` from
Lab. Keep the token server-side. Inject a ledger adapter into the same application
service the browser calls; do not return hardcoded successful UI responses.

The bridge accepts authenticated JSON calls using `Authorization: Bearer <token>`:

- `GET /fixtures`: disposable entity aliases mapped to network IDs.
- `POST /execute`: supported operation; response includes `status` and transaction ID.
- `POST /observe`: supported ledger assertion; response includes `matches` and evidence.
- `GET /capabilities`: check support before using durable receipt operations.

For durable behavior, consult the installed bridge contract for `/execute-once`
and `/receipt`, retaining stable business request IDs. Do not invent a retry API
or implement blind resubmission based on a missing mirror response.

Add a scenario `server` with `command`, loopback `url` and optional `timeoutMs`.
The server should print `Local: http://127.0.0.1:<actual-port>`; use an ephemeral
port to avoid collisions. Browser steps support `goto` with an app-relative `path`,
`click` with `selector`, and `fill` with `selector`/`value`. Follow UI actions with
independent ledger assertions as well as relevant `text` assertions.

### Repeated runs and payment completion

Inspect application persistence before writing the adapter. If the app accepts a
runtime directory for payment markers or journals, give each independent disposable
scenario a new directory, for example `await mkdtemp(path.join(tmpdir(), 'lab-app-'))`.
Pass it through the app's existing injection option. Preserve the app's replay
protection; do not delete real payment locks or alter business request IDs to force
a rerun. Restart/recovery scenarios intentionally reuse their own state instead.

Match the real gateway's error behavior. An HTTP 200 from `/execute` can contain a
failed consensus status. When the production gateway throws on non-success, the
injected gateway must do so too:

```js
const response = await fetch(bridge + '/execute', options);
if (!response.ok) throw new Error(`Lab bridge HTTP ${response.status}`);
const result = await response.json();
if (result.status !== 'SUCCESS') throw new Error(`Consensus: ${result.status}`);
return result;
```

A browser click completes before an asynchronous payment necessarily finishes.
Before interpreting recipient balances, wait for evidence of this run's completed
workflow. Use the app's stable completion text when available; `text.equals` is
exact, so do not invent substring matching or hardcode dynamic transaction IDs.
If an audit message is emitted only after successful transfers, its independently
observed presence can gate the balance checks. This proves that path reached the
audit; it does not prove arbitrary failure handling or full batch atomicity.

Run the generated command twice with separate output directories. Both runs must
reach the intended operation; a second run blocked by `EEXIST`, a stale marker or
an unfinished request is an integration failure, not another payment defect.
Read each report's operation statuses, observed values and skipped assertions
before explaining it. Do not attribute a missing message to the simulator when
that run never submitted one, or carry observations from an earlier run into a
later report. Keep the initial report when fixing an integration error. Freeze
the reviewed scenarios and adapter before asking for an application repair.

This route runs a local app server and Chromium. The hosted signing worker rejects
browser/server commands: local browser coverage does not imply that the same
scenario is accepted by a hosted worker.

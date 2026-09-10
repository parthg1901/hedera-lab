# Transaction recovery after an ambiguous response

Hedera Lab's bridge now records a stable application request and the original
transaction ID before submitting a recoverable operation. If the response is lost,
a retry checks that transaction's receipt. It does not create a new transaction.
The ticketing server enables this path when the bridge advertises durable receipts.

## Before and after

Previously, a lost check-in response left an in-memory `checkInUncertain` flag.
The running app avoided duplicates, but could not resolve the outcome and forgot
that guard on restart. A restarted app could submit another HCS attendance message.

Now the bridge owns the journal. A restarted app uses the same business request ID,
recovers the original successful receipt, and returns `Checked in`. Eight
retries in the recorded restart demo returned the same transaction ID and produced no new
submissions. An independent ledger read found exactly one attendance message.

| Failure boundary | Recovery behavior |
| --- | --- |
| Intent saved, process dies before allocating an ID | Remain pending; no automatic submission |
| ID saved, process dies before sending | Read that ID; remain pending if no evidence exists |
| Consensus succeeds, response is lost | Recover the original receipt and persist the result |
| Result saved, HTTP response is lost | Return the saved result |
| Receipt unavailable or expired, mirror has not indexed it | Remain pending; missing data is not a failed transaction |
| Proven failure such as wallet decline | An explicit retry may create a new attempt; history is retained |
| Same request ID with different operation | Reject without submitting |
| Journal cannot be persisted | Stop; no further writes from that journal instance |

The pre-submission crash cases intentionally sacrifice automatic progress. This
implementation does not retransmit saved signed bytes, expire an idempotency key,
or interpret a missing receipt as permission to spend again.

## Run the demonstration

```sh
npm run build
node scripts/lab-recovery-eval.mjs
```

The script starts the actual authenticated HTTP bridge, purchases a ticket,
loses an HCS response after execution, restarts the bridge and application, and
checks recovery plus independent NFT/HCS evidence. Reports are written beneath
`.harness/runs/receipt-recovery-*/report.json`. The default is simulated: the
simulated ledger represents the surviving network while the app/bridge restart.

The current evaluator creates eight separate application service instances so
their retry requests reach the HTTP bridge concurrently; one application's internal
queue no longer serializes the experiment. After restarting, it first **injects a
temporarily unavailable receipt lookup** by making reconciliation return `null`.
Eight retries must remain pending with zero submissions. It then restores normal
reconciliation and requires eight retries to recover the original transaction ID.
This probe tests the application's response to missing evidence; it does not claim
that a receipt or archive record was actually missing from the live network.

Live modes additionally reserve a separate request with a real SDK-generated
customer transaction ID and deliberately stop **before sending it**. This models
the ID-persisted/pre-submission failure boundary without adding an attendance
message. The evaluator restores the ordinary adapter and performs a receipt read
plus an explicit retry through the bridge. Both must retain the original ID and
stay pending, with no submission. These calls use the real SDK receipt query and
mirror archive reconciliation; a separate mirror read must also show the ID is
absent. `unsubmittedReceiptProbe` in the report distinguishes this deliberate
non-submission from the earlier injected-null probe. The resulting unresolved
journal entry is intentional; it is not evidence of a lost successful transaction.
This is an additional live-network experiment, not a claim that it has passed on
every supported network.

For real HTS/HCS operations, configure `HEDERA_OPERATOR_ID` and
`HEDERA_OPERATOR_KEY` using the existing testnet setup, then run:

```sh
node scripts/lab-recovery-eval.mjs --testnet
# Kill the actual bridge process after HCS consensus, then recover automatically:
# Requires Linux and util-linux flock, including when the network is on this Mac.
node scripts/lab-recovery-eval.mjs --testnet --crash
```

This provisions disposable testnet accounts, an NFT and an HCS topic, spends
transaction fees, reattaches a new SDK adapter to the same fixtures, and cleans up.
It does not buy verification or make an x402 payment. **Both the graceful restart
and actual SIGKILL recovery flows passed on testnet on 2026-09-06.** Each recovered
the original HCS receipt across eight retries, made zero new business submissions
after restart, and independently observed one attendance message plus correct NFT
ownership. Cleanup completed for both runs; cleanup transactions are outside the
business-submission count. Solo subsequently passed both flows on the Apple Silicon laptop; see below.

For Solo, first deploy the local network, verify its actual endpoints, and configure
a funded **local ECDSA operator**. Do not reuse testnet credentials. The evaluator
accepts the network section of a validated local scenario:

```sh
node scripts/lab-recovery-eval.mjs --local examples/lab-ticketing/scenarios/local.yaml
# Run inside Linux with access to the same Solo endpoints and persistent journal:
node scripts/lab-recovery-eval.mjs --local examples/lab-ticketing/scenarios/local.yaml --crash
```

`--local` requires `network.mode: local` plus explicit loopback `nodeAddress`,
`nodeAccountId`, and HTTP loopback `mirrorUrl`. Replace example endpoints with the
ones verified for your deployment. A Linux container must have the endpoints
reachable on its own loopback, for example through explicit port forwarding;
the Mac's `127.0.0.1` is not the container's loopback. The evaluator provisions its
own ticketing fixtures; it does not execute the scenario's steps or reuse fixtures
from an earlier `lab run`.

The defaults are `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY`. A scenario may name
dedicated variables through `network.operatorIdEnv` and `network.operatorKeyEnv`,
such as `SOLO_OPERATOR_ID` and `SOLO_OPERATOR_KEY`. The crash worker receives those
same named variables and the exact validated network configuration. Only variable
names and public network configuration belong in the scenario or report; keep
credential values outside tracked files and logs.

`--testnet` and `--local` are mutually exclusive. Invalid local configurations,
missing operator variables, unsupported crash platforms, and missing `flock` fail
before fixture provisioning; the evaluator never falls back to testnet or
simulation. Its local independent evidence uses the configured mirror, checks NFT
ownership, and requires exactly one attendance message with the expected payload
and customer payer. Recorded Solo results and their platform boundaries appear
in the final section below.

## Bridge contract

All routes require the existing server-side bearer token; browser-origin requests
remain forbidden. Credentials and fixture keys never enter the application.

- `GET /capabilities` returns `{ "durableReceipts": true }` when a journal is configured.
- `POST /execute-once` accepts `{ requestId, operation, retryFailed? }`.
- `POST /receipt` accepts `{ requestId }`. It returns a final transaction result,
  a result with `status: "PENDING"`, or `null` for an unknown request ID.
- Original `/execute` and NFT `/observe` remain available for existing integrations.
  `/execute` has **no durable idempotency guarantee**.

Request IDs must represent a business operation, such as one order's check-in.
Generate a new ID for a different order, not for a network retry. The example uses
fixed ticket/customer IDs because every scenario gets fresh fixtures and a separate
journal. A production app needs its own order identity and authorization policy.

`retryFailed: true` authorizes a new attempt only after a definitive failed result.
It cannot retry a pending or successful transaction. The ticketing app sends it on
an explicit user action and returns each failure to the user before another action.

The journal binds requests to their full operation and fixture/network scope,
serializes concurrent callers, retains every attempt, and uses atomic replacement
plus file/directory fsync. Its checksum detects accidental corruption; it is not a
signature or protection against a trusted host editing the journal.

The SDK adapter saves the frozen transaction's ID before sending and disables ID
regeneration and write retries for this path. Reconciliation performs a read-only
receipt query, followed by the mirror transaction endpoint if necessary. Archive
records must match the original ID, operation type, zero nonce and unscheduled
transaction; duplicate-submission records do not resolve an unknown outcome.
See [Hedera's receipt behavior](https://docs.rs/hedera-proto/latest/hedera_proto/services/struct.TransactionGetReceiptQuery.html)
and [transaction archive API](https://docs.hedera.com/api-reference/transactions/get-transaction-by-id).

## Restart and ownership

`runScenario` supplies `<output>/transactions/` automatically. For a long-running
integration, pass a persistent directory as the fifth argument to `startBridge`.
After a graceful stop, restart it with the same ledger resources and directory.

For a live SDK process restart, use `await ledger.resume(fixtures)` on a new
`LiveLedger(network, originalRecoveryDirectory)`, then start the bridge using its
original transaction journal directory. Resume loads disposable signer keys and
entity IDs from `lab-recovery.json`; it does not provision anything. It refuses a
changed network/operator, missing fixtures, and unfinished fixture creation.
It requires the operator environment configuration used by the original adapter.
Do not run `provision()` or point recovery at a freshly reset local network.

A journal allows one owner. **On Linux with util-linux `flock` and a local
filesystem, hard crashes now recover automatically.** The parent process retains a
kernel-owned lock on `owner.guard`. A short-lived `flock` helper acquires that lock
through an inherited file descriptor and exits; it does not own a lease or keep a
separate daemon alive. Process death closes the parent's descriptor and releases
ownership. Restart acquires it before reading or changing any journal state.

**Never remove or replace `owner.guard`.** Its inode must remain stable. The
`owner.lock` file now contains diagnostic metadata, not ownership authority.
Stale metadata, PID reuse, timeouts, and a paused process cannot authorize lock
stealing. Six concurrent restart candidates were tested: exactly one became owner.
An actively paused owner excluded all contenders.

Existing PID-only journals migrate automatically only when their old owner is
confirmed dead. A live legacy owner or unreadable legacy metadata fails closed.
The new metadata remains in place after clean shutdown to prevent older binaries
from bypassing kernel ownership. Do not run old and new versions against the same
journal concurrently.

This automatic path requires Linux, util-linux `flock`, and a local persistent
filesystem. The container build checks that `flock` exists. Missing support fails
closed; network/shared filesystems and multi-host ownership are not supported.
Other operating systems retain the previous exclusive-file behavior, including
manual dead-owner recovery. See the [Linux flock semantics](https://man7.org/linux/man-pages/man2/flock.2.html).

On macOS and Windows, graceful bridge shutdown releases `owner.lock`, allowing a
restart. Process death leaves that exclusive file in place, and every automatic
contender must fail closed. The evaluator therefore rejects `--crash` on these
platforms before provisioning. For an existing native crash journal, stop all
writers and confirm the recorded owner is dead before a human handles the stale
exclusive file; PID age or a failed receipt query is insufficient. Never remove an
`owner.guard` to make a run proceed. The supported automated hard-crash experiment
runs in Linux with its journal on a local persistent filesystem.

A normal completed scenario still cleans up its disposable fixtures. Resuming an
already-cleaned scenario is not a way to recreate its network. The in-memory
simulator does not survive a whole simulator restart; its unique recovery scope
prevents accidentally applying saved receipts to a new simulated ledger with
reused numeric entity IDs.

## Evidence and limits

Testnet and single-node Solo demonstrations covered graceful restart, Linux SIGKILL,
eight concurrent receipt replays and independent mirror observation of one HCS
message. Reproduce the relevant commands above; [results](../results.md) summarizes
what was tested. Historical JSON and laptop inventories live outside the release
source tree.

Missing receipts remain pending. No blind resubmission, whole-cluster-loss recovery,
shared-filesystem ownership, automatic native macOS crash takeover or universal
exactly-once guarantee is claimed. In-flight hosted worker jobs can require operator
recovery even though completed results are durable.

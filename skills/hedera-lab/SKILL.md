---
name: hedera-lab
description: Integrate Hedera applications with Hedera Lab by writing application adapters, transaction plans, protected acceptance scenarios and reproducible verification commands. Use when building a Hedera application that needs Lab verification or adding Lab to an existing project.
---

# Hedera Lab

Make the application verifiable without asking the customer to learn Lab's file
formats. Inspect its real execution path, generate the integration, run appropriate
checks and explain the result. This skill is agent-neutral Markdown; optional
`agents/openai.yaml` supplies UI metadata for compatible hosts.

Resolve `references/` links relative to the directory containing this `SKILL.md`,
not the application or CLI checkout. If a reference read fails, locate and read
the referenced file before generating an adapter; do not silently skip it.

## Establish the connection

Locate the application and a Lab-capable CLI. Use the project's existing toolchain;
check `hedera-harness --help`, or use `node /path/to/hedera-lab/dist/index.js` from a
built checkout. The original upstream Harness may lack Lab commands. Do not assume
the public npm package contains the checked-out implementation or silently upgrade
project dependencies. In commands below, `LAB_CLI` is the absolute path to that
built `dist/index.js`; `APP_ROOT` is the application checkout.

Read the business entry point and its callers, representative inputs, current
network adapter and tests. Identify the function actually used by the application.
Compile TypeScript with its existing build command when necessary. Do not replace
its runtime or generate a separate correct implementation solely for verification.

Extract acceptance requirements from the user's specification. Separate known
requirements from assumptions. Ask only for missing facts that determine correct
behavior, such as an approved recipient, amount or permission. Do not infer expected
results from the plan or use application code to calculate both sides of a check.
For already approved requirements, continue without asking the customer to restate
them. Keep a short readable contract with requirement-to-assertion mappings.

## Choose the smallest useful integration

- **HBAR payout function:** prefer `lab onboard`. It generates the adapter,
  fixtures, two scenarios and contract. Follow the payout path below.
- **HBAR/NFT/HCS preparation or SDK application:** create a thin adapter around
  the real logic and generate a bounded JSON plan. Read
  [application integration](references/integration.md) for the supported schema,
  workspace paths and an executable example. SDK transaction objects are not
  themselves accepted plans; adapt supported operations or inject a test adapter.
- **UI or request workflow:** connect the actual app through a server-side Lab
  bridge and add browser actions plus ledger assertions. Read the browser section
  of [application integration](references/integration.md), including runtime
  isolation, transaction status handling and completion checks. A hand-authored direct
  transaction scenario alone does not test application behavior.
- **Unsupported behavior:** explain the missing adapter or assertion and implement
  it only within the requested scope. The current schema does not cover arbitrary
  smart contracts, fungible-token operations, or every Hedera service. Do not
  manufacture a passing proxy test and describe it as full coverage.

## Payout path

First inspect without executing the application:

```sh
node "$LAB_CLI" lab onboard inspect --workspace "$APP_ROOT"
```

For an exported function returning `{recipient, amount}[]`, supply the discovered
file/export/input and customer-approved amounts to `lab onboard init`. Example:

```sh
node "$LAB_CLI" lab onboard init --workspace "$APP_ROOT" \
  --entry src/payouts.mjs --export preparePayouts --input examples/batch.json \
  --format transfers --actor treasury --expect alice=0.75,bob=0.25 \
  --allow-execution
```

Replace the sample paths and requirements. `--format plan` accepts only HBAR payout
plans in this wizard; use a custom scenario for NFT/HCS. Initialization runs a free
simulation. `--allow-execution` invokes trusted application code locally with no
sandbox. Use it when local execution is within the user's authorized task; do not
import an untrusted downloaded repository merely to inspect it.

Review generated `verification/CONTRACT.md`, the adapter and assertions against the
approved requirements. Record that review, then use the same checks after repairs:

```sh
node "$LAB_CLI" lab onboard approve --workspace "$APP_ROOT"
node "$LAB_CLI" lab onboard check --workspace "$APP_ROOT" --allow-execution
```

`approve` records a local contract hash, not a wallet authorization or customer
signature. Never record approval for unresolved assumptions. `check` rebuilds app
output and rejects changed protected files or uncovered operations. If an integration
already exists, inspect and update it deliberately; `init` does not overwrite it.
Do not erase approval or rewrite expected values simply to make a failing run pass.

## Prove that it tests the app

Run the app's ordinary checks and a free simulated Lab scenario first. Rebuild the
plan from the current source before every custom-plan run. Keep input, source and
plan provenance together; a stale plan cannot verify new code. Use a disposable
negative control or an existing regression that changes the actual app behavior
or input while retaining the same requirements. A meaningful mismatch should fail;
restore the control afterward and retain the result outside source files.

Before handing off a browser integration:

- Give each independent scenario a fresh temporary app runtime directory through
  the existing injection option, so payment locks from one run cannot block the
  next. Never remove production locks; recovery scenarios reuse their own state.
- Match production gateway failures: check both HTTP success and the returned
  ledger status, throwing on non-`SUCCESS` when the real gateway does.
- Gate balance checks on completed payment evidence, such as an independently
  observed audit emitted after transfers. A click is not completion, and unchanged
  balances alone do not prove exclusion from a completed payment.
- Run the same scenario twice with separate report directories and confirm both
  reach the intended operations. Do not stop after the first expected failure.
- Explain each report using its own operations and observed values. Skipped
  assertions are unverified; never carry an earlier run's evidence into a later one.

For repairs, change the application, rebuild, and rerun the fixed contract. If
requirements intentionally change, explain and review that change rather than
presenting it as a repair. Distinguish infrastructure failures from app defects.
Generated reports and private state belong under ignored `.harness/runs/` or the
wizard's ignored `verification/runs/`, not in the committed source tree.

## Live execution and delivery

Start with simulation unless the user already requested and authorized a live run.
For Solo, use confirmed deployment endpoints; for testnet, use the configured
operator and bounded fixtures. Never embed credentials or production account IDs
in test plans. Reuse existing authorization for bounded live work, but a general
request to build an app or install this skill is not permission to spend funds.
Do not create a fresh transaction after an ambiguous receipt merely to obtain a pass.

For paid hosting, the provider configures prices, execution caps and immutable
registration. The generated app files are a handoff, not a deployed service or paid
contract. Read [hosted handoff](references/hosting.md) only when hosting or paid
verification is part of the task. Do not invent an upload API, settlement or public URL.

Finish with: the application path verified; files/commands needed to reproduce it;
assertions exercised; actual mode (`simulated`, `local`, `testnet`, or a specifically
supported read-only mainnet preflight); pass/fail and report location; material gaps.
A simulator pass is not evidence of testnet behavior, and a successful payment is
not evidence that the application's assertions passed.

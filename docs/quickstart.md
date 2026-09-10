# Quick start

This guide runs from a repository checkout. Use Node.js 24 LTS and npm for the
validated path; the package declares Node >=20, but this walkthrough was validated
on Node 24. Clone access is required while the repository is private.

## Install

```sh
git clone git@github.com:parthg1901/hedera-lab.git
cd hedera-lab
npm ci
npm run build
```

## Bring your own payout app

Run `node dist/index.js lab onboard init --workspace /path/to/your-app` for the
interactive payout wizard. It generates the verification files and runs a free
simulation from customer-approved recipient amounts. See [onboarding](onboarding.md)
for supported functions, explicit local execution consent, review, and reruns.

## 1. Verify a ledger scenario without credentials

```sh
node dist/index.js lab run examples/lab-ticketing/scenarios/ledger.yaml
```

Expected: `PASS` with `[simulated]` and a report path. Open that `index.html` to
inspect fixtures, NFT ownership and attendance assertions. No Docker, browser or
wallet is required. Simulation does not establish real network behavior.

## 2. Use the dashboard without paying on-chain

```sh
node dist/index.js verify serve \
  --config examples/verification/payment-catalog.json \
  --store .harness/runs/quickstart-exchange
```

Leave this process running. Open http://127.0.0.1:4318 on the same machine.
The terminal prints the location of a private customer token file, not its value.
Read that file locally and enter the value in **Customer authorization**.

1. Keep the default 0.1 HBAR service budget and required checks.
2. Click **Authorize budget**.
3. Click **Request quote** (or **Agent: propose within budget**).
4. Review the package selection and click **Accept & reserve**.
5. Click **Execute with simulated payment**.
6. Wait for the delivered result; expand **inspect evidence**.

Expected: passing protocol checks and updated spending/reservation totals. This
catalog tests Exchange behavior, including payment replay and budget races, using
simulated settlement. No real HBAR is spent. Stop the server with Ctrl-C.

Use a different port and store for another service process. If you change catalogs,
use a fresh store: stored identities prevent silently reusing another service's jobs.

## 3. Exercise the ticketing UI in Chromium

```sh
npx playwright install --with-deps chromium
npm run lab:demo
```

Expected: a passing purchase/check-in scenario with real browser actions and a
simulated ledger. Browser/system dependency installation may require OS permissions.
The resulting report labels browser execution separately from the ledger mode.

## Next steps

- [Understand budgets and the complete user flow](user-flow.md).
- [Onboard a second app with a prepared payout plan](../examples/grant-flow/README.md).
- [Write a scenario for your own registered application](lab/README.md).
- [Make a real paid testnet request](operations/live-testnet.md).
- [Inspect recorded results without rerunning paid work](results.md).

Keep private keys, customer tokens, capabilities and recovery journals out of Git.
The application does not automatically load `.env` files. Live setup is separate
from this credential-free walkthrough.

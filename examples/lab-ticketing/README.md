# Ticketing scenario app

A deliberately small app for testing the Hedera Lab harness: claim an NFT ticket,
then write an HCS attendance record. The server uses Lab's test signer bridge;
it is not a production wallet integration or a paid ticket marketplace.

From the harness repository root:

```sh
npm ci
npm run build
npx playwright install --with-deps chromium
node dist/index.js lab run examples/lab-ticketing/scenarios/purchase.yaml \
  --workspace examples/lab-ticketing
```

`server.mjs` binds an ephemeral loopback port and requires the bridge environment
injected by Lab. Run it through Lab, not directly. Every scenario gets fresh state.

| Scenario | Checks |
|---|---|
| purchase | Browser purchase, NFT ownership, check-in, HCS message |
| delayed-mirror | Successful purchase survives delayed indexed reads |
| wallet-rejection | Simulated actor refusal preserves ownership and shows rejection |
| double-purchase | Repeating purchase retains the original successful state |
| missing-association | Exact rejection, then association and successful transfer |
| insufficient-funds | Exact rejection and unchanged simulated HBAR balance |
| unauthorized-transfer | Non-owner cannot transfer the NFT |
| ledger | Browser-free HTS + HCS workflow |
| local | SDK HTS + HCS workflow against your Solo endpoints |
| testnet | SDK HTS + HCS workflow against funded testnet |

See [the Lab guide](../../docs/lab/README.md) for schema, live-network setup,
limitations, and real-agent repair experiments.

The server detects the bridge's durable receipt capability. With recovery enabled,
a lost HCS response can be resolved after app/bridge restart using the original
transaction ID; a retry does not create another attendance message. Legacy adapters
retain the in-memory pending guard and cannot reconcile HCS receipts.

Run `node scripts/lab-recovery-eval.mjs` from the repository root for the restart
demonstration. Run `node scripts/ticket-stress.mjs examples/lab-ticketing` for the
original compatibility checks used by the Exchange recovery package. See the
[recovery guide](../../docs/lab/RECOVERY.md) for the API, testnet command, journal
ownership, and cases that deliberately remain pending.

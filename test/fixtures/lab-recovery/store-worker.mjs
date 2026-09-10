import { Store } from "../../../dist/verification/store.js";
const store = new Store(process.argv[2]);
await store.start();
await store.mutate((state) => {
  state.deploymentProbe = "persisted-before-crash";
});
process.send({ ready: true });
process.on("message", async () => {
  await store.close();
  process.exit(0);
});

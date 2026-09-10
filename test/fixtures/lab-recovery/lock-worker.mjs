import { acquireJournalOwnership } from "../../../dist/lab/ownership.js";
try {
  const release = await acquireJournalOwnership(process.argv[2]);
  process.send({ owned: true });
  process.on("message", async (message) => {
    if (message === "close") {
      await release();
      process.exit(0);
    }
  });
} catch {
  process.send({ owned: false });
  process.exit(2);
}

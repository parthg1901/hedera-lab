import test from "node:test";
import assert from "node:assert/strict";
import { preparePayout } from "../examples/grant-flow/grant-service.mjs";
function permutations(items) {
  return items.length
    ? items.flatMap((item, i) =>
        permutations(items.filter((_, j) => j !== i)).map((p) => [item, ...p]),
      )
    : [[]];
}
test("GrantFlow preserves approved recipient amounts across independent directory and grant orderings", () => {
  const grants = [
    { recipient: "alice", hbar: 0.75 },
    { recipient: "bob", hbar: 0.25 },
    { recipient: "carol", hbar: 0.5 },
  ];
  let checked = 0;
  for (const directory of permutations(["alice", "bob", "carol"]))
    for (const ordered of permutations(grants)) {
      const operations = preparePayout({
        batchId: "regression",
        directory,
        grants: ordered,
      }).operations.filter((o) => o.type === "transferHbar");
      assert.deepEqual(
        operations.map((o) => [o.to, o.amount]),
        ordered.map((g) => [g.recipient, g.hbar]),
      );
      checked++;
    }
  assert.equal(checked, 36);
});

import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
const [root, workspace, output] = process.argv.slice(2);
const { runSession } = await import(
  pathToFileURL(root + "/dist/sessionRunner.js")
);
const result = await runSession({
  workspacePath: workspace,
  specPath: workspace + "/.harness/spec.yaml",
});
await writeFile(output, JSON.stringify(result, null, 2));

// Translate the original Harness's Claude-style MCP delivery to the installed Codex CLI.
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
const argv = process.argv.slice(2),
  index = argv.indexOf("--mcp-config");
if (index < 0) throw Error("Missing real Playwright MCP config");
const config = JSON.parse(await readFile(argv[index + 1], "utf8")).mcpServers
  .playwright;
const prompt = argv[0];
const dir = await mkdtemp("/tmp/harness-validator-");
const args = [
  "exec",
  "--ephemeral",
  "--json",
  "--sandbox",
  "read-only",
  "--skip-git-repo-check",
  "-c",
  `mcp_servers.playwright.command=${JSON.stringify(config.command)}`,
  "-c",
  `mcp_servers.playwright.args=${JSON.stringify([...config.args, "--output-dir", dir + "/browser"])}`,
  "-c",
  "mcp_servers.playwright.required=true",
  "-c",
  'mcp_servers.playwright.default_tools_approval_mode="approve"',
  "-c",
  "mcp_servers.playwright.startup_timeout_sec=60",
  "--output-last-message",
  dir + "/answer.txt",
  "-C",
  process.cwd(),
  prompt,
];
const run = await new Promise((resolve) => {
  const child = execFile(
    "codex",
    args,
    { timeout: 240000, maxBuffer: 8000000 },
    (error, stdout, stderr) =>
      resolve({ error: error?.message, stdout, stderr }),
  );
  child.stdin.end();
});
await writeFile(dir + "/raw.json", JSON.stringify(run));
const events = run.stdout.split("\n").flatMap((s) => {
  try {
    return [JSON.parse(s)];
  } catch {
    return [];
  }
});
const calls = events.filter(
  (e) => e.type === "item.completed" && e.item?.type === "mcp_tool_call",
);
const navigated = calls.some(
  (e) =>
    e.item.server === "playwright" &&
    e.item.tool === "browser_navigate" &&
    e.item.status === "completed" &&
    !e.item.error &&
    !e.item.result?.isError,
);
console.error(
  JSON.stringify({
    validatorEvidence: dir,
    actualMcpCalls: calls.length,
    successfulNavigation: navigated,
    error: run.error,
  }),
);
if (run.error || !navigated) {
  console.log(
    JSON.stringify({
      passed: false,
      summary: "Real browser validator infrastructure failed",
      issues: [
        {
          id: "MCP",
          severity: "critical",
          description:
            run.error ?? "No successful real browser navigation observed",
        },
      ],
    }),
  );
  process.exitCode = 1;
} else {
  const answer = await readFile(dir + "/answer.txt", "utf8");
  console.log(JSON.stringify({ type: "result", result: answer }));
}
